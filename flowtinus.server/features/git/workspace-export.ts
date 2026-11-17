import { connectionToYaml, folderPath, GITATTRIBUTES, isFolderVisible, projectToYaml, repoFlowToYaml, repoPath, workspaceToYaml, type ConnectionTypeName, type FlowFile } from '@flowtinus/core';
import { loadTree } from '#features/folders/project-tree';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { queueGitCommit, type GitChanges } from './git-commits';

export type RepoFiles = Record<string, string>;

/**
 * the whole workspace as the environment's branch holds it: `.gitattributes`, `workspace.yaml`, the connections'
 * declarations and every active project with its scripts and the flows ever deployed (the deployed version, or the one
 * last deployed with `deployed: false`); drafts, configurations and values stay out
 */
export async function exportWorkspace(db: Database, workspaceId: string): Promise<RepoFiles> {
    const [[workspace], connections, projects, flowVersions, scripts, scriptFolders] = await Promise.all([
        db.query<{ slug: string }>('SELECT slug FROM workspaces WHERE id = $1', [workspaceId]),
        db.query<{ id: string; name: string; type: ConnectionTypeName }>('SELECT id, name, type FROM connections WHERE workspace_id = $1', [
            workspaceId,
        ]),
        db.query<{ id: string; name: string; description: string; icon: string; color: string }>(
            'SELECT id, name, description, icon, color FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL',
            [workspaceId],
        ),
        db.query<{ flow_id: string; deployed: boolean; definition: FlowFile }>(
            `SELECT f.id AS flow_id, d.flow_version_id IS NOT NULL AS deployed, v.definition
       FROM flows f
       LEFT JOIN deployments d ON d.flow_id = f.id
       JOIN flow_versions v ON v.id = coalesce(
         d.flow_version_id,
         (SELECT coalesce(h.to_version_id, h.from_version_id) FROM deployment_history h WHERE h.flow_id = f.id ORDER BY h.id DESC LIMIT 1),
         (SELECT n.id FROM flow_versions n WHERE n.flow_id = f.id ORDER BY n.number DESC LIMIT 1))
      WHERE f.workspace_id = $1 AND f.deleted_at IS NULL AND f.removed_at IS NULL`,
            [workspaceId],
        ),
        db.query<{ project_id: string; path: string; content: string }>(
            'SELECT project_id, path, content FROM scripts WHERE workspace_id = $1',
            [workspaceId],
        ),
        db.query<{ project_id: string; path: string }>('SELECT project_id, path FROM script_folders WHERE workspace_id = $1', [
            workspaceId,
        ]),
    ]);
    const slug = workspace!.slug;
    const versions = new Map(flowVersions.map(v => [v.flow_id, v]));
    const files: RepoFiles = {
        [repoPath.gitattributes]: GITATTRIBUTES,
        [repoPath.workspace(slug)]: workspaceToYaml(),
    };
    for (const connection of connections) {
        files[repoPath.connection(slug, connection.name)] = connectionToYaml(connection);
    }

    for (const project of projects) {
        files[repoPath.project(slug, project.name)] = projectToYaml(project);
        const tree = await loadTree(db, workspaceId, project.id);
        const names = (folderId: string | null) => folderPath(tree.folders, folderId).map(f => f.name);
        const flowPaths: string[] = [];
        for (const flow of tree.flows.filter(f => f.archivedAt === null && isFolderVisible(tree.folders, f.folderId))) {
            const version = versions.get(flow.id);
            if (version) {
                const path = repoPath.flow(slug, project.name, names(flow.folderId), flow.name);
                files[path] = repoFlowToYaml({ ...version.definition, id: flow.id }, { deployed: version.deployed });
                flowPaths.push(path);
            }
        }

        const folders = tree.folders
            .filter(f => isFolderVisible(tree.folders, f.id))
            .map(f => repoPath.folder(slug, project.name, names(f.id)));
        for (const keep of folders) {
            const inside = keep.slice(0, -'.gitkeep'.length);
            if (![...flowPaths, ...folders].some(path => path !== keep && path.startsWith(inside))) {
                files[keep] = '';
            }
        }

        const projectScripts = scripts.filter(s => s.project_id === project.id);
        for (const script of projectScripts) {
            files[repoPath.script(slug, project.name, script.path)] = script.content;
        }
        const scriptPaths = projectScripts.map(s => s.path);
        const folderPaths = scriptFolders.filter(f => f.project_id === project.id).map(f => f.path);
        for (const folder of folderPaths) {
            if (![...scriptPaths, ...folderPaths].some(path => path.startsWith(`${folder}/`))) {
                files[repoPath.scriptFolder(slug, project.name, folder)] = '';
            }
        }
    }

    return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** what turns the files `before` into `after`: each file written or changed, with its content, and each removed, as null */
export function repoChanges(before: RepoFiles, after: RepoFiles): GitChanges {
    const changes: GitChanges = {};
    for (const [path, content] of Object.entries(after)) {
        if (before[path] !== content) {
            changes[path] = content;
        }
    }
    for (const path of Object.keys(before)) {
        if (!(path in after)) {
            changes[path] = null;
        }
    }
    return changes;
}

/** the whole workspace as one commit, in the transaction of ctx.db: the first export of a branch without the workspace */
export async function queueWorkspaceExport(ctx: UseCaseContext, message: string): Promise<boolean> {
    return queueGitCommit(ctx, { message, changes: () => exportWorkspace(ctx.db, ctx.workspaceId) });
}
