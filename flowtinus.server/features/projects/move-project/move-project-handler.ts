import { z } from 'zod';
import { workspaceHandleIn } from '#features/workspaces/workspace';
import { componentSettings, CONNECTION_KEY, DYNAMIC_CONNECTION, flowResources, flowWithScriptsMoved, handleOf, movedScriptImports, scriptImportPrefix, type FlowFile } from '@flowtinus/core';
import { FlowRepository, longRepoPath } from '#features/folders/project-tree';
import { loadDraft, writeDraft } from '#features/flows/flow-draft';
import { scriptFileId } from '#features/git/working-copy';
import { workingScripts, writeScript } from '#features/scripts/script-store';
import { changeTree } from '#features/git/git-first';
import { workBranch } from '#features/git/branch-read';
import { gitBranch } from '#features/git/git-config';
import { undeployArchived } from '#features/deployments/deployments';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { flows as flowsTable } from '#features/flows/flow';
import { projects } from '#features/projects/project';
import { handleTaken } from '#features/projects/project-fields';
import { ProjectRepository } from '#features/projects/project-repository';
import { workspaces } from '#features/workspaces/workspace';
import { roleAtLeast, workspaceMembers } from '#features/workspaces/workspace-member';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { requireRole } from '#shared/use-cases/require-role';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';

export const MoveProjectCommand = z.object({ id: z.uuid('Invalid'), toWorkspace: z.string().trim().min(1, 'Required') });

export type MoveProjectResponse = { id: string; workspace: string; undeployed: number };

const BY_PROJECT = ['folders', 'flows', 'script_folders', 'flow_schedules', 'flow_webhooks', 'runs', 'test_runs'];
const BY_FLOW = ['flow_versions', 'deployments', 'deployment_history'];

type Draft = { revision: number; flow: FlowFile };

type Missing = { connections: string[]; secrets: string[]; variables: string[] };

/**
 * Moves a project to another workspace of the user: an admin of its workspace and at least an editor of the other. The
 * connection profiles, secrets and variables its active flows use (in their drafts and in their deployed versions) must
 * exist in the destination by the same names, or nothing moves and the answer lists what is missing. Then, at once, the
 * project and everything of it (folders, flows, versions, deployments and their history, scripts, schedules, webhooks,
 * runs) go to the destination; the drafts pick the destination's profiles of the same names; the deployed flows are
 * undeployed (their versions name the old profiles, and a version never changes) and their schedules and webhooks
 * turned off.
 */
export class MoveProjectHandler implements UseCaseHandler<MoveProjectResponse> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<MoveProjectResponse>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const parsed = validate(MoveProjectCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id, toWorkspace } = parsed.value;
        // its runs, versions, deployments, schedules and webhooks move with it, and they are the environment's, not a branch's
        if (await workBranch(ctx)) {
            const environment = (await gitBranch(ctx.db, ctx.workspaceId))?.branch;
            return fail(
                'conflict',
                `A project moves to another workspace on ${environment} only: its runs, deployments, schedules and webhooks go with it. Pick ${environment} to move it.`,
            );
        }
        const [project] = await ctx.db.orm
            .select({ name: projects.name })
            .from(projects)
            .where(and(eq(projects.id, id), eq(projects.workspaceId, ctx.workspaceId), isNull(projects.deletedAt)));
        if (!project) {
            return fail('not-found', 'Project not found.');
        }

        const [target] = await ctx.db.orm
            .select({ id: workspaces.id, role: workspaceMembers.role })
            .from(workspaces)
            .leftJoin(
                workspaceMembers,
                and(eq(workspaceMembers.workspaceId, workspaces.id), sql`${workspaceMembers.userId}::text = ${ctx.userId}`),
            )
            .where(and(eq(workspaces.handle, toWorkspace), isNull(workspaces.deletedAt)));
        if (!target || !target.role) {
            return fail('not-found', `Workspace "${toWorkspace}" not found among yours.`, { toWorkspace: 'Not found' });
        }
        if (!roleAtLeast(target.role, 'editor')) {
            return fail('forbidden', `Only an editor or an admin of "${toWorkspace}" can move a project into it.`);
        }
        if (target.id === ctx.workspaceId) {
            return fail('validation', 'The project is already in this workspace.', { toWorkspace: 'Same workspace' });
        }
        const holder = await new ProjectRepository(ctx.db, target.id).handleHolder(project.name);
        if (holder) {
            return handleTaken(project.name, holder, { workspace: toWorkspace, field: 'toWorkspace' });
        }

        const tooLong = await longRepoPath(ctx, id, { project: project.name, workspaceId: target.id });
        if (tooLong) {
            return fail('validation', `${tooLong} in "${toWorkspace}".`, { toWorkspace: 'Path too long there' });
        }

        const rows = await ctx.db.query<{ id: string; deployed: FlowFile | null }>(
            `SELECT f.id, v.definition AS deployed
         FROM flows f
         LEFT JOIN deployments d ON d.flow_id = f.id
         LEFT JOIN flow_versions v ON v.id = d.flow_version_id
        WHERE f.project_id = $1 AND f.deleted_at IS NULL AND f.removed_at IS NULL`,
            [id],
        );
        const flowRows = await new FlowRepository(ctx.db, ctx.workspaceId).findMany(eq(flowsTable.projectId, id));
        const flows: { id: string; draft: Draft | null; deployed: FlowFile | null }[] = [];
        for (const row of rows) {
            const flow = flowRows.find(f => f.id === row.id);
            flows.push({ ...row, draft: flow ? await loadDraft(ctx.db, ctx.workspaceId, flow) : null });
        }
        const used = { connectionIds: new Set<string>(), secrets: new Set<string>(), variables: new Set<string>() };
        for (const flow of flows) {
            for (const file of [flow.draft?.flow, flow.deployed]) {
                if (!file?.nodes) {
                    continue;
                }
                const found = flowResources(file);
                found.connectionIds.forEach(c => used.connectionIds.add(c));
                found.secrets.forEach(s => used.secrets.add(s));
                found.variables.forEach(v => used.variables.add(v));
            }
        }

        const names = async (table: 'connections' | 'secrets' | 'variables', workspaceId: string) =>
            await ctx.db.query<{ id: string; name: string }>(`SELECT id, name FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
        const [sourceConnections, targetConnections, targetSecrets, targetVariables] = await Promise.all([
            names('connections', ctx.workspaceId),
            names('connections', target.id),
            names('secrets', target.id),
            names('variables', target.id),
        ]);
        const sourceName = new Map(sourceConnections.map(c => [c.id, c.name]));
        const targetIdByName = new Map(targetConnections.map(c => [c.name.toLowerCase(), c.id]));
        const has = (rows: { name: string }[]) => {
            const set = new Set(rows.map(r => r.name.toLowerCase()));
            return (name: string) => set.has(name.toLowerCase());
        };
        const missing: Missing = {
            connections: [...used.connectionIds]
                .map(c => sourceName.get(c))
                .filter((name): name is string => !!name && !targetIdByName.has(name.toLowerCase()))
                .sort(),
            secrets: [...used.secrets].filter(s => !has(targetSecrets)(s)).sort(),
            variables: [...used.variables].filter(v => !has(targetVariables)(v)).sort(),
        };
        if (missing.connections.length || missing.secrets.length || missing.variables.length) {
            const list = [
                ...missing.connections.map(n => `connection "${n}"`),
                ...missing.secrets.map(n => `secret "${n}"`),
                ...missing.variables.map(n => `variable "${n}"`),
            ];
            const fields = Object.fromEntries(
                Object.entries(missing)
                    .filter(([, v]) => v.length)
                    .map(([k, v]) => [k, v.join(', ')]),
            );
            return fail(
                'conflict',
                `"${toWorkspace}" does not have what the flows of "${project.name}" use: ${list.join(', ')}. Create them there first.`,
                fields,
            );
        }

        const ownScripts = {
            from: scriptImportPrefix(await workspaceHandleIn(ctx.db, ctx.workspaceId), handleOf(project.name)).slice(0, -1),
            to: scriptImportPrefix(toWorkspace, handleOf(project.name)).slice(0, -1),
        };
        const flowIds = flows.map(f => f.id);
        const deployed = flows.filter(f => f.deployed).length;
        await changeTree(
            ctx,
            async tx => {
                await undeployArchived(tx, ctx, flowIds);

                const drafts = new Map<string, FlowFile>();
                for (const flow of flows) {
                    if (!flow.draft?.flow?.nodes) {
                        continue;
                    }
                    drafts.set(flow.id, flow.draft.flow);
                    let changed = false;
                    const nodes = flow.draft.flow.nodes.map(node => {
                        const config = { ...node.config };
                        for (const setting of componentSettings(node.type)) {
                            const key = setting.key ?? CONNECTION_KEY;
                            const value = config[key];
                            if (setting.kind !== 'connection' || typeof value !== 'string' || !value || value === DYNAMIC_CONNECTION) {
                                continue;
                            }
                            const name = sourceName.get(value);
                            const to = name ? targetIdByName.get(name.toLowerCase()) : undefined;
                            if (to && to !== value) {
                                config[key] = to;
                                changed = true;
                            }
                        }
                        return { ...node, config };
                    });
                    const remapped = changed ? { ...flow.draft.flow, nodes } : flow.draft.flow;
                    drafts.set(flow.id, flowWithScriptsMoved(remapped, ownScripts.from, ownScripts.to) ?? remapped);
                }

                // the code the runs took, for the destination's runs to keep reading it
                await tx.query(
                    `INSERT INTO script_blobs (workspace_id, hash, content)
         SELECT $3, b.hash, b.content FROM script_blobs b
          WHERE b.workspace_id = $2 AND b.hash IN (
            SELECT s.value FROM runs r, jsonb_each_text(coalesce(r.scripts, '{}'::jsonb)) s WHERE r.project_id = $1
            UNION SELECT s.value FROM test_runs r, jsonb_each_text(coalesce(r.scripts, '{}'::jsonb)) s WHERE r.project_id = $1)
         ON CONFLICT DO NOTHING`,
                    [id, ctx.workspaceId, target.id],
                );

                await tx.orm.update(projects).set({ workspaceId: target.id }).where(eq(projects.id, id));
                for (const table of BY_PROJECT) {
                    await tx.query(`UPDATE ${table} SET workspace_id = $2 WHERE project_id = $1`, [id, target.id]);
                }
                for (const table of BY_FLOW) {
                    await tx.query(`UPDATE ${table} SET workspace_id = $2 WHERE flow_id IN (SELECT id FROM flows WHERE project_id = $1)`, [
                        id,
                        target.id,
                    ]);
                }

                const scripts = await workingScripts(tx, ctx.workspaceId, id);
                await tx.query(
                    `DELETE FROM working_copy WHERE workspace_id = $1 AND (file_id = ANY($2::text[]) OR starts_with(file_id, $3))`,
                    [ctx.workspaceId, [...drafts.keys()], scriptFileId(id, '')],
                );
                await tx.query(`DELETE FROM deployed_scripts WHERE project_id = $1`, [id]);
                for (const moved of await new FlowRepository(tx, target.id).findMany(eq(flowsTable.projectId, id))) {
                    const draft = drafts.get(moved.id);
                    if (draft) {
                        await writeDraft(tx, target.id, moved, draft, ctx.userId, undefined, { asNew: true });
                    }
                }
                for (const script of scripts) {
                    await writeScript(
                        tx,
                        target.id,
                        id,
                        script.path,
                        movedScriptImports(script.content, ownScripts.from, ownScripts.to),
                        ctx.userId,
                    );
                }
            },
            [target.id],
        );

        return success({ id, workspace: toWorkspace, undeployed: deployed });
    }
}
