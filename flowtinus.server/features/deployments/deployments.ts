import { deployContent, isFolderVisible, type FlowFile, type TriggerKind } from '@flowtinus/core';
import type { Database } from '#shared/database/database';
import { pgJson } from '#shared/database/jsonb';
import { eq } from 'drizzle-orm';
import { flows, type Flow } from '#features/flows/flow';
import { draftTriggersChanged, loadDraft } from '#features/flows/flow-draft';
import { FlowRepository, loadTree } from '#features/folders/project-tree';
import { gitBranch, isGitOn, readGitConfig } from '#features/git/git-config';
import type { Mode } from '#features/git/topology';
import { changedImports } from '#features/scripts/script-git';
import { withUpdatedByName } from '#features/users/user-names';
import { SCHEDULES_CHANNEL } from '#features/schedules/schedules';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail } from '#shared/use-cases/use-case-result';
import { endsEmergencyRollbackByAccident, endsRollbackMessage, hasGitContent } from './emergency-rollback/emergency-rollback-content';

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
    commit: string | null;
    commitMessage?: string;
    endsEmergencyRollback?: string;
    /** with git on: what choosing this version in an emergency rollback does; absent, the rollback is not offered */
    emergencyRollbackOffer?: EmergencyRollbackOffer;
};

export type EmergencyRollbackOffer = 'roll-back' | 'end';

export type DeploymentAction = 'deploy' | 'rollback' | 'undeploy' | 'emergency-rollback' | 'end-emergency-rollback';

export type DeploymentEventView = {
    action: DeploymentAction;
    fromNumber: number | null;
    toNumber: number | null;
    at: Date;
    by: string | null;
    byName?: string;
    commit: string | null;
};

export type FlowDeploymentsView = {
    versions: FlowVersionView[];
    deployed: { versionId: string; deployedAt: Date; deployedBy: string | null; deployedByName?: string } | null;
    history: DeploymentEventView[];
    /** with git on: the environment's branch, where a deploy is a commit */
    git?: { branch: string | null; mode: Mode };
    /** with git on: the commit the draft could not be merged with */
    draftConflict?: string;
    /** with git on: the changed scripts the draft imports, directly or through another script, which a Commit can take along */
    changedScripts?: string[];
    triggersChanged?: true;
    /** with git on: the version that runs is not git's, until a commit changes the flow's content or someone ends it */
    emergencyRollback?: EmergencyRollbackView;
};

export type EmergencyRollbackState = { number: number; gitNumber: number; by: string | null; byName?: string; at: Date };

export type EmergencyRollbackView = EmergencyRollbackState & { versionId: string; gitVersionId: string };

export const gitVersionOf = (view: Pick<FlowDeploymentsView, 'versions' | 'deployed' | 'emergencyRollback'>) =>
    view.versions.find(v => v.id === (view.emergencyRollback?.gitVersionId ?? view.deployed?.versionId));

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
    const [versions, deployed, history, commits, git, [flow], rollback, ran] = await Promise.all([
        db.query<{
            id: string;
            number: number;
            definition: FlowFile;
            content_hash: string;
            created_at: Date;
            created_by: string | null;
            commit_sha: string | null;
        }>(
            `SELECT id, number, definition, content_hash, created_at, created_by, commit_sha FROM flow_versions WHERE workspace_id = $1 AND flow_id = $2 ORDER BY number DESC`,
            [workspaceId, flowId],
        ),
        db.query<{ flow_version_id: string; deployed_at: Date; deployed_by: string | null }>(
            `SELECT flow_version_id, deployed_at, deployed_by FROM deployments WHERE workspace_id = $1 AND flow_id = $2`,
            [workspaceId, flowId],
        ),
        db.query<{
            action: DeploymentAction;
            from_number: number | null;
            to_number: number | null;
            at: Date;
            by_user: string | null;
            commit_sha: string | null;
        }>(
            `SELECT h.action, f.number AS from_number, t.number AS to_number, h.at, h.by_user, h.commit_sha
       FROM deployment_history h
       LEFT JOIN flow_versions f ON f.id = h.from_version_id
       LEFT JOIN flow_versions t ON t.id = h.to_version_id
       WHERE h.workspace_id = $1 AND h.flow_id = $2 ORDER BY h.id DESC LIMIT 200`,
            [workspaceId, flowId],
        ),
        db.query<{ sha: string; message: string; author_name: string }>(
            `SELECT sha, message, author_name FROM git_commits WHERE workspace_id = $1 AND sha IN (
               SELECT commit_sha FROM flow_versions WHERE flow_id = $2 UNION SELECT commit_sha FROM deployment_history WHERE flow_id = $2)`,
            [workspaceId, flowId],
        ),
        gitBranch(db, workspaceId),
        new FlowRepository(db, workspaceId).findAll(eq(flows.id, flowId)),
        emergencyRollbackOf(db, workspaceId, flowId),
        db.query<{ to_version_id: string }>(
            `SELECT DISTINCT to_version_id FROM deployment_history WHERE workspace_id = $1 AND flow_id = $2 AND to_version_id IS NOT NULL`,
            [workspaceId, flowId],
        ),
    ]);
    const draft = git && flow ? await loadDraft(db, workspaceId, flow) : null;
    const commit = new Map(commits.map(c => [c.sha, c]));
    const who = await names(db, [
        ...versions.map(v => v.created_by),
        ...deployed.map(d => d.deployed_by),
        ...history.map(h => h.by_user),
        rollback?.by ?? null,
    ]);
    // a commit's author who is no app user is named as git has it
    const named = (id: string | null, sha: string | null = null) =>
        id && who.has(id) ? who.get(id) : !id && sha ? commit.get(sha)?.author_name : undefined;
    const current = deployed[0];
    const ends = flow ? await rollbackEndWarning(db, workspaceId, flow, rollback) : () => null;
    const running = versions.find(v => v.id === current?.flow_version_id);
    const ranHere = new Set(ran.map(r => r.to_version_id));
    const offer = (v: { id: string; content_hash: string }): EmergencyRollbackOffer | null => {
        if (!git || !running || v.content_hash === running.content_hash) {
            return null;
        }
        if (rollback && hasGitContent(rollback, v.content_hash)) {
            return 'end';
        }
        return ranHere.has(v.id) ? 'roll-back' : null;
    };
    return {
        versions: versions.map(v => ({
            id: v.id,
            flowId,
            number: v.number,
            definition: v.definition,
            createdAt: new Date(v.created_at),
            createdBy: v.created_by,
            ...(named(v.created_by, v.commit_sha) ? { createdByName: named(v.created_by, v.commit_sha) } : {}),
            commit: v.commit_sha,
            ...(v.commit_sha && commit.has(v.commit_sha) ? { commitMessage: commit.get(v.commit_sha)!.message } : {}),
            ...(ends(v.content_hash) ? { endsEmergencyRollback: ends(v.content_hash)! } : {}),
            ...(offer(v) ? { emergencyRollbackOffer: offer(v)! } : {}),
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
            ...(named(h.by_user, h.commit_sha) ? { byName: named(h.by_user, h.commit_sha) } : {}),
            commit: h.commit_sha,
        })),
        ...(git ? { git } : {}),
        ...(draft?.conflict ? { draftConflict: draft.conflict } : {}),
        ...(draft && flow ? { changedScripts: await changedImports(db, workspaceId, flow.projectId, draft.flow) } : {}),
        ...(git && flow && (await draftTriggersChanged(db, workspaceId, flow)) ? { triggersChanged: true as const } : {}),
        ...(rollback
            ? { emergencyRollback: { versionId: rollback.versionId, gitVersionId: rollback.git.id, ...rollbackState(rollback, who) } }
            : {}),
    };
}

export type DeployedVersion = { id: string; number: number; hash: string };

export async function currentDeployment(db: Database, workspaceId: string, flowId: string): Promise<DeployedVersion | null> {
    const [row] = await db.query<{ id: string; number: number; content_hash: string }>(
        `SELECT v.id, v.number, v.content_hash FROM deployments d JOIN flow_versions v ON v.id = d.flow_version_id
     WHERE d.workspace_id = $1 AND d.flow_id = $2`,
        [workspaceId, flowId],
    );
    return row ? { id: row.id, number: row.number, hash: row.content_hash } : null;
}

export type EmergencyRollback = {
    flowId: string;
    versionId: string;
    number: number;
    hash: string;
    git: DeployedVersion;
    by: string | null;
    at: Date;
};

export async function emergencyRollbacks(db: Database, workspaceId: string, flowIds: string[] | null = null): Promise<EmergencyRollback[]> {
    const rows = await db.query<{
        flow_id: string;
        version_id: string;
        number: number;
        hash: string;
        git_version_id: string;
        git_number: number;
        git_hash: string;
        by_user: string | null;
        at: Date;
    }>(
        `SELECT r.flow_id, r.version_id, v.number, v.content_hash AS hash, r.git_version_id, g.number AS git_number,
         g.content_hash AS git_hash, r.by_user, r.at
       FROM emergency_rollbacks r JOIN flow_versions v ON v.id = r.version_id JOIN flow_versions g ON g.id = r.git_version_id
      WHERE r.workspace_id = $1 AND ($2::uuid[] IS NULL OR r.flow_id = ANY($2::uuid[]))`,
        [workspaceId, flowIds],
    );
    return rows.map(row => ({
        flowId: row.flow_id,
        versionId: row.version_id,
        number: row.number,
        hash: row.hash,
        git: { id: row.git_version_id, number: row.git_number, hash: row.git_hash },
        by: row.by_user,
        at: new Date(row.at),
    }));
}

export async function emergencyRollbackOf(db: Database, workspaceId: string, flowId: string): Promise<EmergencyRollback | null> {
    return (await emergencyRollbacks(db, workspaceId, [flowId]))[0] ?? null;
}

const rollbackState = (rollback: EmergencyRollback, who: Map<string, string>): EmergencyRollbackState => ({
    number: rollback.number,
    gitNumber: rollback.git.number,
    by: rollback.by,
    ...(rollback.by && who.has(rollback.by) ? { byName: who.get(rollback.by) } : {}),
    at: rollback.at,
});

export async function emergencyRollbackStates(
    db: Database,
    workspaceId: string,
    flowIds: string[],
): Promise<Map<string, EmergencyRollbackState>> {
    const rollbacks = await emergencyRollbacks(db, workspaceId, flowIds);
    const who = await names(
        db,
        rollbacks.map(r => r.by),
    );
    return new Map(rollbacks.map(r => [r.flowId, rollbackState(r, who)]));
}

async function rollbackEndWarning(db: Database, workspaceId: string, flow: Pick<Flow, 'id' | 'name'>, rollback: EmergencyRollback | null) {
    const config = rollback ? await readGitConfig(db, workspaceId) : null;
    return (hash: string) =>
        rollback && config && endsEmergencyRollbackByAccident(rollback, { deployed: true, hash })
            ? endsRollbackMessage([flow.name], config.environment)
            : null;
}

export async function draftEndsEmergencyRollback(db: Database, workspaceId: string, flow: Flow, draft: FlowFile): Promise<string | null> {
    const ends = await rollbackEndWarning(db, workspaceId, flow, await emergencyRollbackOf(db, workspaceId, flow.id));
    return ends(contentHash(draft));
}

export async function versionDefinition(db: Database, versionId: string): Promise<FlowFile> {
    const [row] = await db.query<{ definition: FlowFile }>('SELECT definition FROM flow_versions WHERE id = $1', [versionId]);
    return row!.definition;
}

/** what git's branch deploys: the deployed version, unless an emergency rollback runs another one */
export async function gitDeployment(db: Database, workspaceId: string, flowId: string): Promise<DeployedVersion | null> {
    return (await emergencyRollbackOf(db, workspaceId, flowId))?.git ?? (await currentDeployment(db, workspaceId, flowId));
}

/**
 * The row goes, and the history says which version it left. Back to git's version, that version runs again; otherwise
 * (a commit, git turned off) what runs next is the caller's.
 */
export async function endEmergencyRollback(
    db: Database,
    by: Actor,
    flowId: string,
    end: { commit: string | null } | { backToGit: DeployedVersion },
): Promise<void> {
    const [ended] = await db.query<{ version_id: string }>(
        'DELETE FROM emergency_rollbacks WHERE workspace_id = $1 AND flow_id = $2 RETURNING version_id',
        [by.workspaceId, flowId],
    );
    if (!ended) {
        return;
    }

    if ('backToGit' in end) {
        await setDeployed(db, by, flowId, 'end-emergency-rollback', ended.version_id, end.backToGit.id);
    } else {
        await recordDeployment(db, by, flowId, 'end-emergency-rollback', ended.version_id, null, end.commit);
    }
}

const UNDEPLOYED: Record<TriggerKind, string> = {
    schedule: 'Deploy the flow first: only a deployed flow runs on a schedule.',
    webhook: 'Deploy the flow first: a webhook runs its deployed version.',
};

export const refuseUndeployed = async (db: Database, workspaceId: string, flowId: string, kind: TriggerKind) =>
    (await currentDeployment(db, workspaceId, flowId)) ? null : fail('validation', UNDEPLOYED[kind]);

/** one flow's changes of what is deployed, one at a time (two deploys at once would take the same number) */
export const lockFlowDeployments = (db: Database, flowId: string) =>
    db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deploy:${flowId}`]);

/** who changes what is deployed: null for a commit whose author is no app user */
export type Actor = { workspaceId: string; userId: string | null };

export async function setDeployed(
    db: Database,
    ctx: Actor,
    flowId: string,
    action: DeploymentAction,
    from: string | null,
    to: string | null,
    commit: string | null = null,
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

    await recordDeployment(db, ctx, flowId, action, from, to, commit);
}

const recordDeployment = (
    db: Database,
    ctx: Actor,
    flowId: string,
    action: DeploymentAction,
    from: string | null,
    to: string | null,
    commit: string | null,
) =>
    db.query(
        `INSERT INTO deployment_history (workspace_id, flow_id, from_version_id, to_version_id, action, by_user, commit_sha)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ctx.workspaceId, flowId, from, to, action, ctx.userId, commit],
    );

export async function newestVersionLike(
    db: Database,
    workspaceId: string,
    flowId: string,
    definition: FlowFile,
): Promise<{ id: string; number: number } | null> {
    const [newest] = await db.query<{ id: string; number: number; content_hash: string }>(
        'SELECT id, number, content_hash FROM flow_versions WHERE workspace_id = $1 AND flow_id = $2 ORDER BY number DESC LIMIT 1',
        [workspaceId, flowId],
    );
    return newest?.content_hash === contentHash(definition) ? { id: newest.id, number: newest.number } : null;
}

export async function insertVersion(
    db: Database,
    ctx: Actor,
    flowId: string,
    definition: FlowFile,
    commit: string | null = null,
): Promise<{ id: string; number: number }> {
    const id = crypto.randomUUID();
    const [row] = await db.query<{ number: number }>(
        `INSERT INTO flow_versions (id, workspace_id, flow_id, number, definition, content_hash, created_by, commit_sha)
     SELECT $1, $2, $3, coalesce(max(number), 0) + 1, $4::text::jsonb, $5, $6, $7 FROM flow_versions WHERE flow_id = $3
     RETURNING number`,
        [id, ctx.workspaceId, flowId, pgJson(definition), contentHash(definition), ctx.userId, commit],
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
export async function undeployArchived(
    db: Database,
    ctx: Actor,
    flowIds: string[],
    applied: { commit: string | null } | null = null,
): Promise<void> {
    // with git on, an archive is a change of the working copy: the flow runs as deployed until its Commit
    if (flowIds.length === 0 || (!applied && (await isGitOn(db, ctx.workspaceId)))) {
        return;
    }
    const commit = applied?.commit ?? null;

    await turnOffTriggers(db, ctx, flowIds);

    const rows = await db.query<{ flow_id: string }>(
        'SELECT flow_id FROM deployments WHERE workspace_id = $1 AND flow_id = ANY($2::uuid[])',
        [ctx.workspaceId, flowIds],
    );
    for (const { flow_id: flowId } of rows) {
        await lockFlowDeployments(db, flowId);
        await endEmergencyRollback(db, ctx, flowId, { commit });
        const current = await currentDeployment(db, ctx.workspaceId, flowId);
        if (current) {
            await setDeployed(db, ctx, flowId, 'undeploy', current.id, null, commit);
        }
    }
}

export async function turnOffTriggers(db: Database, ctx: Actor, flowIds: string[]): Promise<void> {
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
