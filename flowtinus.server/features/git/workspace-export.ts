import { connectionToYaml, folderPath, GITATTRIBUTES, isFolderVisible, projectToYaml, repoFlowToYaml, repoPath, workspaceToYaml, type ConnectionTypeName, type FlowFile } from '@flowtinus/core';
import { loadTree } from '#features/folders/project-tree';
import type { Database } from '#shared/database/database';
import type { GitChanges } from './git-commits';

export type RepoFiles = Record<string, string>;

export type FlowInRepo = { flow_id: string; deployed: boolean; definition: FlowFile; content_hash: string };

// a flow not deployed is at the version last deployed, or at a newer one git brought with deployed: false (a version no
// deploy ever reached, made with or after the last change of what is deployed)
export const flowsInRepo = (db: Database, workspaceId: string, flowIds: string[] | null = null) =>
    db.query<FlowInRepo>(
        `SELECT f.id AS flow_id, d.flow_version_id IS NOT NULL AS deployed, v.definition, v.content_hash
       FROM flows f
       LEFT JOIN deployments d ON d.flow_id = f.id
       JOIN flow_versions v ON v.id = coalesce(
         d.flow_version_id,
         (SELECT n.id FROM flow_versions n WHERE n.flow_id = f.id
           AND NOT EXISTS (SELECT 1 FROM deployment_history h WHERE h.flow_id = f.id AND (h.from_version_id = n.id OR h.to_version_id = n.id OR h.at > n.created_at))
          ORDER BY n.number DESC LIMIT 1),
         (SELECT coalesce(h.to_version_id, h.from_version_id) FROM deployment_history h WHERE h.flow_id = f.id ORDER BY h.id DESC LIMIT 1))
      WHERE f.workspace_id = $1 AND f.deleted_at IS NULL AND f.removed_at IS NULL AND ($2::uuid[] IS NULL OR f.id = ANY($2::uuid[]))`,
        [workspaceId, flowIds],
    );

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
        flowsInRepo(db, workspaceId),
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
