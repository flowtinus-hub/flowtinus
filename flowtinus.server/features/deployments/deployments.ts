import { deployContent, isFolderVisible, type FlowFile } from '@flowtinus/core';
import type { Database } from '#shared/database/database';
import { pgJson } from '#shared/database/jsonb';
import type { Flow } from '#features/flows/flow';
import { FlowRepository, loadTree } from '#features/folders/project-tree';
import { withUpdatedByName } from '#features/users/user-names';
import { SCHEDULES_CHANNEL } from '#features/schedules/schedules';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';

/*
 * A flow's deploys in its own environment (a promotion to another environment is apart): a deploy freezes the draft as
 * a new immutable version (flow_versions) and makes it the deployed one (deployments, one row per flow); every change
 * of what is deployed goes to deployment_history. The deployed version is what the triggers run and what the Flow
 * Invokers call; the draft stays the editor's (Run and Run for real run it). Scripts and connection profiles are not
 * frozen: they are the project's, a change applies to every deployed flow. Name, folder and worker tag are the flows
 * row's: no deploy.
 */

export type FlowVersionView = {
    id: string;
    flowId: string;
    number: number;
    definition: FlowFile;
    createdAt: Date;
    createdBy: string | null;
    createdByName?: string;
};

export type DeploymentAction = 'deploy' | 'promote' | 'rollback' | 'undeploy';

export type DeploymentEventView = {
    action: DeploymentAction;
    fromNumber: number | null;
    toNumber: number | null;
    at: Date;
    by: string | null;
    byName?: string;
};

export type FlowDeploymentsView = {
    versions: FlowVersionView[];
    deployed: { versionId: string; deployedAt: Date; deployedBy: string | null; deployedByName?: string } | null;
    history: DeploymentEventView[];
};

/** what makes two versions the same flow (core's deployContent): not its name, nor where its components are */
export const contentHash = (flow: FlowFile) => new Bun.CryptoHasher('sha256').update(deployContent(flow)).digest('hex');

export async function activeFlow(ctx: UseCaseContext, id: string): Promise<Flow | null> {
    const row = await new FlowRepository(ctx.db, ctx.workspaceId).findById(id);
    const tree = row ? await loadTree(ctx.db, ctx.workspaceId, row.projectId) : null;
    return row && tree && isFolderVisible(tree.folders, row.folderId) ? row : null;
}

async function names(db: Database, ids: (string | null)[]): Promise<Map<string, string>> {
    const rows = await withUpdatedByName(
        db,
        [...new Set(ids.filter((id): id is string => !!id))].map(id => ({ updatedBy: id })),
    );
    return new Map(rows.flatMap(r => (r.updatedByName && r.updatedBy ? [[r.updatedBy, r.updatedByName] as const] : [])));
}

export async function loadDeployments(db: Database, workspaceId: string, flowId: string): Promise<FlowDeploymentsView> {
    const [versions, deployed, history] = await Promise.all([
        db.query<{ id: string; number: number; definition: FlowFile; created_at: Date; created_by: string | null }>(
            `SELECT id, number, definition, created_at, created_by FROM flow_versions WHERE workspace_id = $1 AND flow_id = $2 ORDER BY number DESC`,
            [workspaceId, flowId],
        ),
        db.query<{ flow_version_id: string; deployed_at: Date; deployed_by: string | null }>(
            `SELECT flow_version_id, deployed_at, deployed_by FROM deployments WHERE workspace_id = $1 AND flow_id = $2`,
            [workspaceId, flowId],
        ),
        db.query<{ action: DeploymentAction; from_number: number | null; to_number: number | null; at: Date; by_user: string | null }>(
            `SELECT h.action, f.number AS from_number, t.number AS to_number, h.at, h.by_user
       FROM deployment_history h
       LEFT JOIN flow_versions f ON f.id = h.from_version_id
       LEFT JOIN flow_versions t ON t.id = h.to_version_id
       WHERE h.workspace_id = $1 AND h.flow_id = $2 ORDER BY h.id DESC LIMIT 200`,
            [workspaceId, flowId],
        ),
    ]);
    const who = await names(db, [...versions.map(v => v.created_by), ...deployed.map(d => d.deployed_by), ...history.map(h => h.by_user)]);
    const named = (id: string | null) => (id && who.has(id) ? who.get(id) : undefined);
    const current = deployed[0];
    return {
        versions: versions.map(v => ({
            id: v.id,
            flowId,
            number: v.number,
            definition: v.definition,
            createdAt: new Date(v.created_at),
            createdBy: v.created_by,
            ...(named(v.created_by) ? { createdByName: named(v.created_by) } : {}),
        })),
        deployed: current
            ? {
                  versionId: current.flow_version_id,
                  deployedAt: new Date(current.deployed_at),
                  deployedBy: current.deployed_by,
                  ...(named(current.deployed_by) ? { deployedByName: named(current.deployed_by) } : {}),
              }
            : null,
        history: history.map(h => ({
            action: h.action,
            fromNumber: h.from_number,
            toNumber: h.to_number,
            at: new Date(h.at),
            by: h.by_user,
            ...(named(h.by_user) ? { byName: named(h.by_user) } : {}),
        })),
    };
}

export async function currentDeployment(
    db: Database,
    workspaceId: string,
    flowId: string,
): Promise<{ id: string; number: number; hash: string } | null> {
    const [row] = await db.query<{ id: string; number: number; content_hash: string }>(
        `SELECT v.id, v.number, v.content_hash FROM deployments d JOIN flow_versions v ON v.id = d.flow_version_id
     WHERE d.workspace_id = $1 AND d.flow_id = $2`,
        [workspaceId, flowId],
    );
    return row ? { id: row.id, number: row.number, hash: row.content_hash } : null;
}

/** one flow's changes of what is deployed, one at a time (two deploys at once would take the same number) */
export const lockFlowDeployments = (db: Database, flowId: string) =>
    db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deploy:${flowId}`]);

export async function setDeployed(
    db: Database,
    ctx: { workspaceId: string; userId: string },
    flowId: string,
    action: DeploymentAction,
    from: string | null,
    to: string | null,
): Promise<void> {
    if (to) {
        await db.query(
            `INSERT INTO deployments (workspace_id, flow_id, flow_version_id, deployed_by, deployed_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (flow_id) DO UPDATE SET flow_version_id = $3, deployed_by = $4, deployed_at = now()`,
            [ctx.workspaceId, flowId, to, ctx.userId],
        );
    } else {
        await db.query('DELETE FROM deployments WHERE workspace_id = $1 AND flow_id = $2', [ctx.workspaceId, flowId]);
    }

    await db.query(
        `INSERT INTO deployment_history (workspace_id, flow_id, from_version_id, to_version_id, action, by_user) VALUES ($1, $2, $3, $4, $5, $6)`,
        [ctx.workspaceId, flowId, from, to, action, ctx.userId],
    );
}

export async function insertVersion(
    db: Database,
    ctx: { workspaceId: string; userId: string },
    flowId: string,
    definition: FlowFile,
): Promise<{ id: string; number: number }> {
    const id = crypto.randomUUID();
    const [row] = await db.query<{ number: number }>(
        `INSERT INTO flow_versions (id, workspace_id, flow_id, number, definition, content_hash, created_by)
     SELECT $1, $2, $3, coalesce(max(number), 0) + 1, $4::text::jsonb, $5, $6 FROM flow_versions WHERE flow_id = $3
     RETURNING number`,
        [id, ctx.workspaceId, flowId, pgJson(definition), contentHash(definition), ctx.userId],
    );
    return { id, number: row!.number };
}

export async function deployedDefinitions(
    db: Database,
    workspaceId: string,
    flowIds: string[],
): Promise<Map<string, { versionId: string; definition: FlowFile }>> {
    if (flowIds.length === 0) {
        return new Map();
    }

    const rows = await db.query<{ flow_id: string; version_id: string; definition: FlowFile }>(
        `SELECT d.flow_id, v.id AS version_id, v.definition FROM deployments d JOIN flow_versions v ON v.id = d.flow_version_id
     WHERE d.workspace_id = $1 AND d.flow_id = ANY($2::uuid[])`,
        [workspaceId, flowIds],
    );
    return new Map(rows.map(r => [r.flow_id, { versionId: r.version_id, definition: r.definition }]));
}

/**
 * Archiving (a flow, its folder or its project) or deleting what was archived: those of these flows that are deployed
 * stop being deployed, as an undeploy in their history, and their schedules and webhooks are turned off (restoring one
 * turns nothing back on). In the archive's transaction.
 */
export async function undeployArchived(db: Database, ctx: { workspaceId: string; userId: string }, flowIds: string[]): Promise<void> {
    if (flowIds.length === 0) {
        return;
    }

    await turnOffTriggers(db, ctx, flowIds);

    const rows = await db.query<{ flow_id: string }>(
        'SELECT flow_id FROM deployments WHERE workspace_id = $1 AND flow_id = ANY($2::uuid[])',
        [ctx.workspaceId, flowIds],
    );
    for (const { flow_id: flowId } of rows) {
        await lockFlowDeployments(db, flowId);
        const current = await currentDeployment(db, ctx.workspaceId, flowId);
        if (current) {
            await setDeployed(db, ctx, flowId, 'undeploy', current.id, null);
        }
    }
}

async function turnOffTriggers(db: Database, ctx: { workspaceId: string; userId: string }, flowIds: string[]): Promise<void> {
    const schedules = await db.query<{ flow_id: string }>(
        `UPDATE flow_schedules SET enabled = false, next_fire_at = NULL, updated_by = $3, updated_at = now()
     WHERE workspace_id = $1 AND flow_id = ANY($2::uuid[]) AND enabled RETURNING flow_id`,
        [ctx.workspaceId, flowIds, ctx.userId],
    );
    await db.query(
        `UPDATE flow_webhooks SET enabled = false, updated_by = $3, updated_at = now()
     WHERE workspace_id = $1 AND flow_id = ANY($2::uuid[]) AND enabled`,
        [ctx.workspaceId, flowIds, ctx.userId],
    );
    for (const flowId of new Set(schedules.map(s => s.flow_id))) {
        await db.notify(SCHEDULES_CHANNEL, flowId);
    }
}
