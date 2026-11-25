import { connectionToYaml, folderPath, GITATTRIBUTES, isFolderVisible, newFlowFile, projectToYaml, repoEntry, repoFlowFromYaml, repoFlowToYaml, repoPath, workspaceToYaml, type ConnectionTypeName, type FlowFile, type RepoEntry, type RepoSchedule, type RepoTriggers, type RepoWebhook } from '@flowtinus/core';
import { workspaceHandleIn } from '#features/workspaces/workspace';
import { loadTree } from '#features/folders/project-tree';
import type { Database } from '#shared/database/database';
import { bestRows, scriptFileId, workingRows } from './working-copy';

export type RepoFiles = Record<string, string>;

type EntryOf<K extends RepoEntry['kind']> = Extract<RepoEntry, { kind: K }>;

export function workspaceEntries<K extends RepoEntry['kind']>(
    files: RepoFiles,
    handle: string,
    kind: K,
): { entry: EntryOf<K>; text: string }[] {
    return Object.entries(files).flatMap(([path, text]) => {
        const entry = repoEntry(path);
        return entry.kind === kind && 'workspace' in entry && entry.workspace === handle ? [{ entry: entry as EntryOf<K>, text }] : [];
    });
}

export const flowName = (entry: EntryOf<'flow'>) => [entry.project, ...entry.folders, entry.name].join('/');

export type GitChanges = Record<string, string | null>;

export type FlowInRepo = { flow_id: string; deployed: boolean; definition: FlowFile; content_hash: string } & RepoTriggers;

type TriggerRows = { schedules: (Omit<RepoSchedule, 'input'> & { input: unknown })[]; webhooks: RepoWebhook[] };

// a flow not deployed is at the version last deployed, or at a newer one git brought with deployed: false (a version no
// deploy ever reached, made with or after the last change of what is deployed); one in an emergency rollback is at the
// version git deploys, not the one that runs
export const flowsInRepo = async (db: Database, workspaceId: string, flowIds: string[] | null = null): Promise<FlowInRepo[]> =>
    (
        await db.query<Omit<FlowInRepo, keyof RepoTriggers> & TriggerRows>(
            `SELECT f.id AS flow_id, d.flow_version_id IS NOT NULL AS deployed, v.definition, v.content_hash,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'cron', s.cron, 'timezone', s.timezone, 'misfire', s.misfire,
             'parameters', s.parameters, 'input', s.input)), '[]'::jsonb)
           FROM flow_schedules s WHERE s.flow_id = f.id AND s.archived_at IS NULL) AS schedules,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'response', w.response)), '[]'::jsonb)
           FROM flow_webhooks w WHERE w.flow_id = f.id AND w.archived_at IS NULL) AS webhooks
       FROM flows f
       LEFT JOIN deployments d ON d.flow_id = f.id
       LEFT JOIN emergency_rollbacks r ON r.flow_id = f.id
       JOIN flow_versions v ON v.id = coalesce(
         r.git_version_id,
         d.flow_version_id,
         (SELECT n.id FROM flow_versions n WHERE n.flow_id = f.id
           AND NOT EXISTS (SELECT 1 FROM deployment_history h WHERE h.flow_id = f.id AND (h.from_version_id = n.id OR h.to_version_id = n.id OR h.at > n.created_at))
          ORDER BY n.number DESC LIMIT 1),
         (SELECT coalesce(h.to_version_id, h.from_version_id) FROM deployment_history h WHERE h.flow_id = f.id ORDER BY h.id DESC LIMIT 1))
      WHERE f.workspace_id = $1 AND f.deleted_at IS NULL AND f.removed_at IS NULL AND ($2::uuid[] IS NULL OR f.id = ANY($2::uuid[]))`,
            [workspaceId, flowIds],
        )
    ).map(row => ({
        ...row,
        schedules: row.schedules.map(({ input, ...schedule }) => (input === null ? schedule : { ...schedule, input })),
    }));

function withDeployed(text: string, name: string, deployed: boolean): string {
    const read = repoFlowFromYaml(text, name);
    return read.ok ? repoFlowToYaml(read.value.flow, { ...read.value, deployed }) : text;
}

export const committedFlowText = (flowId: string, inRepo: Omit<FlowInRepo, 'flow_id' | 'content_hash'>) =>
    repoFlowToYaml({ ...inRepo.definition, id: flowId }, inRepo);

export type Tree = { files: RepoFiles; ids: Record<string, string> };

/** 'deployed': git's version of each flow with the scripts the last applied commit deployed, no draft of a script */
export async function exportTree(db: Database, workspaceId: string, mode: 'working' | 'committed' | 'deployed' = 'working'): Promise<Tree> {
    const [workspace, connections, projects, flowVersions, deployedScripts, scriptFolders, rows] = await Promise.all([
        workspaceHandleIn(db, workspaceId),
        db.query<{ id: string; name: string; type: ConnectionTypeName }>(
            'SELECT id, name, type FROM connections WHERE workspace_id = $1 AND deleted_at IS NULL',
            [workspaceId],
        ),
        db.query<{ id: string; name: string; description: string; icon: string; color: string }>(
            'SELECT id, name, description, icon, color FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL',
            [workspaceId],
        ),
        flowsInRepo(db, workspaceId),
        db.query<{ project_id: string; path: string; content: string }>(
            `SELECT d.project_id, d.path, b.content FROM deployed_scripts d
       JOIN script_blobs b ON b.workspace_id = d.workspace_id AND b.hash = d.hash WHERE d.workspace_id = $1`,
            [workspaceId],
        ),
        db.query<{ project_id: string; path: string }>('SELECT project_id, path FROM script_folders WHERE workspace_id = $1', [
            workspaceId,
        ]),
        workingRows(db, workspaceId),
    ]);
    const handle = workspace;
    const versions = new Map(flowVersions.map(v => [v.flow_id, v]));
    const best = bestRows(rows);
    const files: RepoFiles = {
        [repoPath.gitattributes]: GITATTRIBUTES,
        [repoPath.workspace(handle)]: workspaceToYaml(),
    };
    const ids: Record<string, string> = {};
    const put = (path: string, text: string, id?: string) => {
        files[path] = text;
        if (id) {
            ids[path] = id;
        }
    };
    for (const connection of connections) {
        put(repoPath.connection(handle, connection.name), connectionToYaml(connection), connection.id);
    }

    for (const project of projects) {
        put(repoPath.project(handle, project.name), projectToYaml(project), project.id);
        const tree = await loadTree(db, workspaceId, project.id);
        const names = (folderId: string | null) => folderPath(tree.folders, folderId).map(f => f.name);
        const flowPaths: string[] = [];
        for (const flow of tree.flows.filter(f => f.archivedAt === null && isFolderVisible(tree.folders, f.folderId))) {
            const version = versions.get(flow.id);
            const row = best.get(flow.id);
            // a draft kept by an archive: as deployed as the flow is now
            const draft = row?.deleted && row.content && version ? withDeployed(row.content, flow.name, version.deployed) : row?.content;
            const text =
                mode !== 'working'
                    ? version && committedFlowText(flow.id, version)
                    : (draft ?? (version ? committedFlowText(flow.id, version) : repoFlowToYaml(newFlowFile(flow.name, flow.id))));
            if (text !== undefined) {
                const path = repoPath.flow(handle, project.name, names(flow.folderId), flow.name);
                put(path, text, flow.id);
                flowPaths.push(path);
            }
        }

        const folders = tree.folders
            .filter(f => isFolderVisible(tree.folders, f.id))
            .map(f => repoPath.folder(handle, project.name, names(f.id)));
        for (const keep of folders) {
            const inside = keep.slice(0, -'.gitkeep'.length);
            if (![...flowPaths, ...folders].some(path => path !== keep && path.startsWith(inside))) {
                files[keep] = '';
            }
        }

        const scripts = new Map(deployedScripts.filter(s => s.project_id === project.id).map(s => [s.path, s.content]));
        const prefix = scriptFileId(project.id, '');
        for (const [fileId, row] of mode === 'deployed' ? [] : best) {
            if (fileId.startsWith(prefix)) {
                const path = fileId.slice(prefix.length);
                if (row.deleted) {
                    scripts.delete(path);
                } else {
                    scripts.set(path, row.content ?? '');
                }
            }
        }
        for (const [path, content] of scripts) {
            put(repoPath.script(handle, project.name, path), content, scriptFileId(project.id, path));
        }
        const folderPaths = scriptFolders.filter(f => f.project_id === project.id).map(f => f.path);
        for (const folder of folderPaths) {
            if (![...scripts.keys(), ...folderPaths].some(path => path.startsWith(`${folder}/`))) {
                files[repoPath.scriptFolder(handle, project.name, folder)] = '';
            }
        }
    }

    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return { files: sorted, ids };
}

export const exportWorkspace = async (db: Database, workspaceId: string, mode: 'working' | 'committed' = 'committed') =>
    (await exportTree(db, workspaceId, mode)).files;

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
