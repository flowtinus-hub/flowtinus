import { connectionFromYaml, projectFromYaml, repoEntry, repoFlowFromYaml, validateWorkspaceTree, type RepoEntry, type TreeIssue, type TreeValidation, type WorkspaceTree } from '@flowtinus/core';
import { ConnectionRepository } from '#features/connections/connection-store';
import { insertVersion, setDeployed } from '#features/deployments/deployments';
import type { StoredDraft } from '#features/flows/flow-draft';
import { FlowRepository, FolderRepository } from '#features/folders/project-tree';
import { ProjectRepository } from '#features/projects/project-repository';
import { exportsOf } from '#features/scripts/script-store';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { GitRemote } from './git-remote';
import type { RepoFiles } from './workspace-export';

/** what a commit holds of the workspace: the files of its folder, and the repository's .gitattributes */
export const readBranchWorkspace = (remote: GitRemote, commit: string, slug: string): Promise<RepoFiles> =>
    remote.files(commit, [slug, '.gitattributes']);

export const holdsWorkspace = (files: RepoFiles, slug: string) => Object.keys(files).some(path => path.startsWith(`${slug}/`));

/** whether the workspace has nothing an import would write into: no project (archived ones too) and no connection */
export async function isWorkspaceEmpty(db: Database, workspaceId: string): Promise<boolean> {
    const [row] = await db.query<{ empty: boolean }>(
        `SELECT NOT EXISTS (SELECT 1 FROM projects WHERE workspace_id = $1) AND NOT EXISTS (SELECT 1 FROM connections WHERE workspace_id = $1) AS empty`,
        [workspaceId],
    );
    return row!.empty;
}

/**
 * what a tree is checked against here: the connections configured (one only declared has an empty configuration), the
 * secrets and variables with a value
 */
export async function importEnvironment(db: Database, workspaceId: string): Promise<WorkspaceTree['environment']> {
    const [connections, secrets, variables] = await Promise.all([
        db.query<{ id: string }>(`SELECT id FROM connections WHERE workspace_id = $1 AND config <> '{}'::jsonb`, [workspaceId]),
        db.query<{ name: string }>('SELECT name FROM secrets WHERE workspace_id = $1', [workspaceId]),
        db.query<{ name: string }>('SELECT name FROM variables WHERE workspace_id = $1', [workspaceId]),
    ]);
    return { connections: connections.map(c => c.id), secrets: secrets.map(s => s.name), variables: variables.map(v => v.name) };
}

// lower case only: a flow names its connections and called flows by the id as written, and Postgres gives a uuid back in
// lower case
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Entry<K extends RepoEntry['kind']> = { path: string; text: string; entry: Extract<RepoEntry, { kind: K }> };

function entriesOf(files: RepoFiles, slug: string) {
    const all = Object.entries(files)
        .filter(([path]) => path.startsWith(`${slug}/`))
        .map(([path, text]) => ({ path, text, entry: repoEntry(path) }));
    const of = <K extends RepoEntry['kind']>(kind: K) => all.filter((e): e is Entry<K> => e.entry.kind === kind);
    return {
        connections: of('connection'),
        projects: of('project'),
        flows: of('flow'),
        folders: of('folder'),
        scripts: of('script'),
        scriptFolders: of('scriptFolder'),
    };
}

function idsOf(files: RepoFiles, slug: string): { path: string; id: string }[] {
    const { connections, projects, flows } = entriesOf(files, slug);
    const id = (result: { ok: true; value: { id: string } } | { ok: false }) => (result.ok ? result.value.id : undefined);
    return [
        ...connections.map(e => ({ path: e.path, id: id(connectionFromYaml(e.text)) })),
        ...projects.map(e => ({ path: e.path, id: id(projectFromYaml(e.text)) })),
        ...flows.map(e => {
            const read = repoFlowFromYaml(e.text, e.entry.name);
            return { path: e.path, id: read.ok ? read.value.flow.id : undefined };
        }),
    ].filter((e): e is { path: string; id: string } => e.id !== undefined);
}

/** the core's validation of the workspace's tree, and what this server adds: ids are UUIDs no other workspace has */
export async function validateImport(db: Database, workspaceId: string, slug: string, files: RepoFiles): Promise<TreeValidation> {
    const validation = validateWorkspaceTree({ workspace: slug, files, environment: await importEnvironment(db, workspaceId) });
    const ids = idsOf(files, slug);
    const errors: TreeIssue[] = ids
        .filter(e => !UUID.test(e.id))
        .map(e => ({ path: e.path, message: `The id "${e.id}" is not a UUID in lower case, as this server's ids are.` }));
    const uuids = ids.filter(e => UUID.test(e.id)).map(e => e.id);
    const taken = new Set(
        (
            await db.query<{ id: string }>(
                `SELECT id FROM projects WHERE id = ANY($2::uuid[]) AND workspace_id <> $1
         UNION SELECT id FROM flows WHERE id = ANY($2::uuid[]) AND workspace_id <> $1
         UNION SELECT id FROM connections WHERE id = ANY($2::uuid[]) AND workspace_id <> $1`,
                [workspaceId, uuids],
            )
        ).map(row => row.id),
    );
    errors.push(
        ...ids.filter(e => taken.has(e.id)).map(e => ({ path: e.path, message: `The id "${e.id}" is already used by another workspace.` })),
    );
    return { errors: [...validation.errors, ...errors], warnings: validation.warnings };
}

const nfc = (name: string) => name.normalize('NFC');

/**
 * writes a tree validateImport accepted into an empty workspace, in the transaction of ctx.db: connections declared and
 * not configured, every flow at one version, deployed unless its file says `deployed: false`. Nothing is committed: the
 * branch already holds it.
 */
export async function importWorkspace(ctx: UseCaseContext, slug: string, files: RepoFiles): Promise<void> {
    const { connections, projects, flows, folders, scripts, scriptFolders } = entriesOf(files, slug);
    const { db, workspaceId, userId } = ctx;

    const connectionRepository = new ConnectionRepository(db, workspaceId);
    for (const { text, entry } of connections) {
        const { id, type } = read(connectionFromYaml(text));
        await connectionRepository.insert({ id, name: nfc(entry.name), type, config: {}, updatedBy: userId });
    }

    const projectIds = new Map<string, string>();
    const projectRepository = new ProjectRepository(db, workspaceId);
    for (const { text, entry } of projects) {
        const project = read(projectFromYaml(text));
        projectIds.set(entry.project, project.id);
        await projectRepository.insert({ ...project, name: nfc(entry.project) });
    }

    const folderIds = new Map<string, string>();
    const folderRepository = new FolderRepository(db, workspaceId);
    const folderOf = async (project: string, names: string[]): Promise<string | null> => {
        let parentId: string | null = null;
        for (let i = 1; i <= names.length; i++) {
            const key = JSON.stringify([project, ...names.slice(0, i)]);
            let id = folderIds.get(key);
            if (!id) {
                id = crypto.randomUUID();
                await folderRepository.insert({ id, projectId: projectIds.get(project)!, parentId, name: nfc(names[i - 1]!) });
                folderIds.set(key, id);
            }
            parentId = id;
        }
        return parentId;
    };
    for (const { entry } of folders) {
        await folderOf(entry.project, entry.folders);
    }

    const flowRepository = new FlowRepository(db, workspaceId);
    for (const { text, entry } of flows) {
        const { flow, deployed } = read(repoFlowFromYaml(text, nfc(entry.name)));
        const id = flow.id!;
        const draft: StoredDraft = { revision: 0, flow };
        await flowRepository.insert({
            id,
            projectId: projectIds.get(entry.project)!,
            folderId: await folderOf(entry.project, entry.folders),
            name: flow.name,
            draftDefinition: draft,
            updatedBy: userId,
        });
        const version = await insertVersion(db, ctx, id, flow);
        if (deployed) {
            await setDeployed(db, ctx, id, 'deploy', null, version.id);
        }
    }

    for (const { text, entry } of scripts) {
        await db.query(
            'INSERT INTO scripts (id, workspace_id, project_id, path, content, exports, updated_by) VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7)',
            [crypto.randomUUID(), workspaceId, projectIds.get(entry.project), nfc(entry.path), text, exportsOf(text), userId],
        );
    }
    for (const { entry } of scriptFolders) {
        await db.query('INSERT INTO script_folders (workspace_id, project_id, path) VALUES ($1, $2, $3)', [
            workspaceId,
            projectIds.get(entry.project),
            nfc(entry.path),
        ]);
    }
}

function read<T>(result: { ok: true; value: T } | { ok: false; errors: string[] }): T {
    if (!result.ok) {
        throw new Error(`A file validateImport refuses: ${result.errors.join(' ')}`);
    }
    return result.value;
}
