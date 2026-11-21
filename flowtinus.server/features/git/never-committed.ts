import { repoEntry, repoPath } from '@flowtinus/core';
import { workspaceHandle } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { ENVIRONMENT_BRANCH, workingRows, type WorkingRow } from './working-copy';
import type { RepoFiles } from './workspace-export';

export const liveFolderIds = async (ctx: UseCaseContext) =>
    new Set(
        (
            await ctx.db.query<{ id: string }>('SELECT id FROM folders WHERE workspace_id = $1 AND deleted_at IS NULL', [ctx.workspaceId])
        ).map(f => f.id),
    );

const COMMITTED_FLOW = `(EXISTS (SELECT 1 FROM flow_versions v WHERE v.flow_id = f.id)
    OR EXISTS (SELECT 1 FROM deployments d WHERE d.flow_id = f.id)
    OR EXISTS (SELECT 1 FROM deployment_history h WHERE h.flow_id = f.id))`;

export async function dropNeverCommitted(
    ctx: UseCaseContext,
    removed: WorkingRow[],
    files: RepoFiles,
    foldersBefore: Set<string>,
): Promise<void> {
    const { db, workspaceId } = ctx;
    const idsOf = (kind: string) => removed.filter(r => r.file_id && repoEntry(r.path).kind === kind).map(r => r.file_id!);

    const projects = (
        await db.query<{ id: string }>(
            `SELECT p.id FROM projects p WHERE p.workspace_id = $1 AND p.id = ANY($2::uuid[]) AND p.deleted_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM flows f WHERE f.project_id = p.id AND (f.deleted_at IS NULL OR ${COMMITTED_FLOW}))
           AND NOT EXISTS (SELECT 1 FROM deployed_scripts s WHERE s.project_id = p.id)`,
            [workspaceId, idsOf('project')],
        )
    ).map(p => p.id);

    const flows = (
        await db.query<{ id: string }>(
            `SELECT f.id FROM flows f WHERE f.workspace_id = $1 AND f.deleted_at IS NOT NULL
           AND (f.id = ANY($2::uuid[]) OR f.project_id = ANY($3::uuid[])) AND NOT ${COMMITTED_FLOW}`,
            [workspaceId, idsOf('flow'), projects],
        )
    ).map(f => f.id);
    for (const table of ['flow_schedules', 'flow_webhooks']) {
        await db.query(`DELETE FROM ${table} WHERE workspace_id = $1 AND flow_id = ANY($2::uuid[])`, [workspaceId, flows]);
    }
    await db.query('DELETE FROM flows WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, flows]);

    await dropFolders(ctx, await uncommittedFolders(ctx, files, foldersBefore), projects);

    for (const table of ['runs', 'test_runs']) {
        await db.query(`UPDATE ${table} SET project_id = NULL WHERE workspace_id = $1 AND project_id = ANY($2::uuid[])`, [
            workspaceId,
            projects,
        ]);
    }
    for (const table of ['flow_schedules', 'flow_webhooks', 'script_folders']) {
        await db.query(`DELETE FROM ${table} WHERE workspace_id = $1 AND project_id = ANY($2::uuid[])`, [workspaceId, projects]);
    }
    await db.query('DELETE FROM projects WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, projects]);

    const connections = idsOf('connection');
    await db.query('DELETE FROM connections WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NOT NULL', [
        workspaceId,
        connections,
    ]);

    await db.query(
        `DELETE FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND deleted AND base IS NULL
           AND (file_id = ANY($3::text[]) OR split_part(file_id, '/', 1) = ANY($4::text[]))`,
        [workspaceId, ENVIRONMENT_BRANCH, [...flows, ...projects, ...connections], projects],
    );
}

async function uncommittedFolders(ctx: UseCaseContext, files: RepoFiles, foldersBefore: Set<string>): Promise<string[]> {
    const { db, workspaceId } = ctx;
    const [folders, projects, rows] = await Promise.all([
        db.query<{ id: string; project_id: string; parent_id: string | null; name: string; deleted_at: Date | null }>(
            'SELECT id, project_id, parent_id, name, deleted_at FROM folders WHERE workspace_id = $1',
            [workspaceId],
        ),
        db.query<{ id: string; name: string }>('SELECT id, name FROM projects WHERE workspace_id = $1', [workspaceId]),
        workingRows(db, workspaceId, ENVIRONMENT_BRANCH),
    ]);
    const archived = folders.filter(f => f.deleted_at && foldersBefore.has(f.id));
    if (archived.length === 0) {
        return [];
    }
    const rowPaths = new Set(rows.map(r => r.path));
    const committed = [...Object.keys(files).filter(path => !rowPaths.has(path)), ...rows.filter(r => r.base).map(r => r.path)];
    const byId = new Map(folders.map(f => [f.id, f]));
    const projectNames = new Map(projects.map(p => [p.id, p.name]));
    const handle = await workspaceHandle(ctx);
    return archived
        .filter(folder => {
            const names: string[] = [];
            for (let at: string | null = folder.id; at; at = byId.get(at)?.parent_id ?? null) {
                names.unshift(byId.get(at)!.name);
            }
            const inside = repoPath.folder(handle, projectNames.get(folder.project_id)!, names).slice(0, -'.gitkeep'.length);
            return !committed.some(path => path.startsWith(inside));
        })
        .map(f => f.id);
}

async function dropFolders(ctx: UseCaseContext, folders: string[], projects: string[]): Promise<void> {
    for (let dropped = true; dropped;) {
        dropped =
            (
                await ctx.db.query(
                    `DELETE FROM folders d WHERE d.workspace_id = $1 AND (d.id = ANY($2::uuid[]) OR d.project_id = ANY($3::uuid[]))
                   AND NOT EXISTS (SELECT 1 FROM flows f WHERE f.folder_id = d.id)
                   AND NOT EXISTS (SELECT 1 FROM folders c WHERE c.parent_id = d.id) RETURNING d.id`,
                    [ctx.workspaceId, folders, projects],
                )
            ).length > 0;
    }
}
