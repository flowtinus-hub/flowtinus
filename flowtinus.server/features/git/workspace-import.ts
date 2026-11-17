import { connectionFromYaml, projectFromYaml, repoEntry, repoFlowFromYaml, validateWorkspaceTree, type FlowFile, type RepoEntry, type TreeIssue, type TreeValidation, type WorkspaceTree } from '@flowtinus/core';
import { ConnectionRepository } from '#features/connections/connection-store';
import { currentDeployment, insertVersion, lockFlowDeployments, newestVersionLike, setDeployed, undeployArchived } from '#features/deployments/deployments';
import type { StoredDraft } from '#features/flows/flow-draft';
import { FlowRepository, FolderRepository, loadTree } from '#features/folders/project-tree';
import { archiveProject } from '#features/projects/archive-project/archive-project-handler';
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

/** what the tree cannot be applied over: the transaction is rolled back */
export class ImportConflict extends Error {}

/**
 * makes the workspace hold a tree validateImport accepted, in the transaction of ctx.db; on an empty workspace, the
 * import. Connections arrive declared and not configured, and leave when the tree does not declare them; projects, flows
 * and connections are matched by id, folders and scripts by path; a flow arrives at its version, deployed unless its file
 * says `deployed: false`. What the tree does not hold is archived: projects, folders left empty, and flows ever
 * deployed. Drafts stay as they are: a flow's draft is not changed, and a flow never deployed is not in a tree.
 */
export async function importWorkspace(ctx: UseCaseContext, slug: string, files: RepoFiles): Promise<void> {
    const entries = entriesOf(files, slug);
    await importConnections(ctx, entries.connections);
    const projectIds = await importProjects(ctx, entries.projects);
    const folders = new ProjectFolders(ctx, projectIds);
    for (const { entry } of entries.folders) {
        await folders.folderOf(entry.project, entry.folders);
    }
    await importFlows(ctx, entries.flows, projectIds, folders);
    await folders.archiveUnused();
    await importScripts(ctx, entries.scripts, entries.scriptFolders, projectIds);

    const kept = [...projectIds.values()];
    const others = await ctx.db.query<{ id: string }>(
        'SELECT id FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))',
        [ctx.workspaceId, kept],
    );
    for (const { id } of others) {
        await archiveProject(ctx.db, ctx, id);
    }
}

async function importConnections(ctx: UseCaseContext, entries: Entry<'connection'>[]): Promise<void> {
    const { db, workspaceId, userId } = ctx;
    const declared = entries.map(({ text, entry }) => ({ ...read(connectionFromYaml(text)), name: nfc(entry.name) }));
    const ids = declared.map(c => c.id);
    await db.query('DELETE FROM connections WHERE workspace_id = $1 AND NOT (id = ANY($2::uuid[]))', [workspaceId, ids]);
    const existing = new Map(
        (
            await db.query<{ id: string; name: string; type: string }>('SELECT id, name, type FROM connections WHERE workspace_id = $1', [
                workspaceId,
            ])
        ).map(c => [c.id, c]),
    );
    // two connections trading names would collide on the way: the renamed ones take their id as a name first
    const renamed = declared.filter(c => existing.has(c.id) && existing.get(c.id)!.name !== c.name).map(c => c.id);
    await db.query('UPDATE connections SET name = id::text WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, renamed]);

    const repository = new ConnectionRepository(db, workspaceId);
    for (const { id, name, type } of declared) {
        const was = existing.get(id);
        if (!was) {
            await repository.insert({ id, name, type, config: {}, updatedBy: userId });
        } else if (was.name !== name || was.type !== type) {
            await db.query(
                `UPDATE connections SET name = $3, type = $4, config = CASE WHEN type = $4 THEN config ELSE '{}'::jsonb END,
           updated_by = $5, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
                [workspaceId, id, name, type, userId],
            );
        }
    }
}

/** each project's id by its name in the tree */
async function importProjects(ctx: UseCaseContext, entries: Entry<'project'>[]): Promise<Map<string, string>> {
    const { db, workspaceId } = ctx;
    const existing = new Set(
        (await db.query<{ id: string }>('SELECT id FROM projects WHERE workspace_id = $1', [workspaceId])).map(p => p.id),
    );
    const projectIds = new Map<string, string>();
    const repository = new ProjectRepository(db, workspaceId);
    for (const { text, entry } of entries) {
        const project = read(projectFromYaml(text));
        const name = nfc(entry.project);
        projectIds.set(entry.project, project.id);
        if (existing.has(project.id)) {
            await db.query(
                `UPDATE projects SET name = $3, description = $4, icon = $5, color = $6, deleted_at = NULL, deleted_by = NULL
         WHERE workspace_id = $1 AND id = $2`,
                [workspaceId, project.id, name, project.description, project.icon, project.color],
            );
        } else {
            await repository.insert({ ...project, name });
        }
    }
    return projectIds;
}

type LiveFolder = { id: string; parentId: string | null; name: string };

/** the live folders of the tree's projects, found or made by path; the ones no path reached can be archived after */
class ProjectFolders {
    private readonly live = new Map<string, LiveFolder[]>();
    private readonly used = new Set<string>();

    constructor(
        private readonly ctx: UseCaseContext,
        private readonly projectIds: Map<string, string>,
    ) {}

    private async of(projectId: string): Promise<LiveFolder[]> {
        let folders = this.live.get(projectId);
        if (!folders) {
            const tree = await loadTree(this.ctx.db, this.ctx.workspaceId, projectId);
            folders = tree.folders.filter(f => f.archivedAt === null).map(f => ({ id: f.id, parentId: f.parentId, name: f.name }));
            this.live.set(projectId, folders);
        }
        return folders;
    }

    async folderOf(project: string, names: string[]): Promise<string | null> {
        const projectId = this.projectIds.get(project)!;
        const folders = await this.of(projectId);
        const repository = new FolderRepository(this.ctx.db, this.ctx.workspaceId);
        let parentId: string | null = null;
        for (const raw of names) {
            const name = nfc(raw);
            let folder = folders.find(f => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase());
            if (!folder) {
                folder = { id: crypto.randomUUID(), parentId, name };
                await repository.insert({ id: folder.id, projectId, parentId, name });
                folders.push(folder);
            } else if (folder.name !== name) {
                await repository.update(folder.id, { name });
                folder.name = name;
            }
            this.used.add(folder.id);
            parentId = folder.id;
        }
        return parentId;
    }

    /** a folder no path reached is archived, unless a live flow is in it or below it (a draft never deployed) */
    async archiveUnused(): Promise<void> {
        const projectIds = [...this.projectIds.values()];
        for (const projectId of projectIds) {
            await this.of(projectId);
        }
        const withFlows = new Set(
            (
                await this.ctx.db.query<{ folder_id: string }>(
                    'SELECT DISTINCT folder_id FROM flows WHERE workspace_id = $1 AND project_id = ANY($2::uuid[]) AND deleted_at IS NULL AND folder_id IS NOT NULL',
                    [this.ctx.workspaceId, projectIds],
                )
            ).map(row => row.folder_id),
        );
        const repository = new FolderRepository(this.ctx.db, this.ctx.workspaceId);
        for (const folders of this.live.values()) {
            const keep = new Set(folders.filter(f => this.used.has(f.id) || withFlows.has(f.id)).map(f => f.id));
            for (const folder of folders.filter(f => keep.has(f.id))) {
                for (let up = folder.parentId; up !== null; up = folders.find(f => f.id === up)?.parentId ?? null) {
                    keep.add(up);
                }
            }
            for (const folder of folders.filter(f => !keep.has(f.id))) {
                await repository.update(folder.id, { deletedAt: new Date(), deletedBy: this.ctx.userId });
            }
        }
    }
}

async function importFlows(
    ctx: UseCaseContext,
    entries: Entry<'flow'>[],
    projectIds: Map<string, string>,
    folders: ProjectFolders,
): Promise<void> {
    const { db, workspaceId, userId } = ctx;
    const inTree = entries.map(({ text, entry }) => ({ entry, ...read(repoFlowFromYaml(text, nfc(entry.name))) }));
    const ids = inTree.map(f => f.flow.id!);
    const leaving = await db.query<{ id: string }>(
        `SELECT f.id FROM flows f WHERE f.workspace_id = $1 AND f.deleted_at IS NULL AND NOT (f.id = ANY($2::uuid[]))
       AND EXISTS (SELECT 1 FROM flow_versions v WHERE v.flow_id = f.id)`,
        [workspaceId, ids],
    );
    const repository = new FlowRepository(db, workspaceId);
    for (const { id } of leaving) {
        await repository.update(id, { deletedAt: new Date(), deletedBy: userId });
    }
    await undeployArchived(
        db,
        ctx,
        leaving.map(f => f.id),
    );

    const existing = new Set(
        (await db.query<{ id: string }>('SELECT id FROM flows WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, ids])).map(
            f => f.id,
        ),
    );
    // two flows trading names would collide on the way: each one already here takes its id as a name first
    await db.query('UPDATE flows SET name = id::text WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, [...existing]]);

    for (const { entry, flow, deployed } of inTree) {
        const id = flow.id!;
        const projectId = projectIds.get(entry.project)!;
        const folderId = await folders.folderOf(entry.project, entry.folders);
        const [taken] = await db.query<{ name: string }>(
            `SELECT name FROM flows WHERE workspace_id = $1 AND project_id = $2 AND folder_id IS NOT DISTINCT FROM $3
         AND lower(name) = lower($4) AND deleted_at IS NULL AND NOT (id = ANY($5::uuid[]))`,
            [workspaceId, projectId, folderId, flow.name, ids],
        );
        if (taken) {
            throw new ImportConflict(`The flow ${entry.name} in git has the name of a draft here, ${taken.name}: rename the draft first.`);
        }

        if (existing.has(id)) {
            await db.query(
                `UPDATE flows SET project_id = $3, folder_id = $4, name = $5, deleted_at = NULL, deleted_by = NULL, removed_at = NULL,
           removed_by = NULL, updated_by = $6, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
                [workspaceId, id, projectId, folderId, flow.name, userId],
            );
            for (const table of ['flow_schedules', 'flow_webhooks']) {
                await db.query(`UPDATE ${table} SET project_id = $3 WHERE workspace_id = $1 AND flow_id = $2`, [
                    workspaceId,
                    id,
                    projectId,
                ]);
            }
        } else {
            const draft: StoredDraft = { revision: 0, flow };
            await repository.insert({ id, projectId, folderId, name: flow.name, draftDefinition: draft, updatedBy: userId });
        }

        await deployAsInTree(ctx, id, flow, deployed);
    }
}

/** the flow's version as the tree has it, deployed or not as its file says */
async function deployAsInTree(ctx: UseCaseContext, flowId: string, flow: FlowFile, deployed: boolean): Promise<void> {
    const { db, workspaceId } = ctx;
    await lockFlowDeployments(db, flowId);
    let current: { id: string } | null = await currentDeployment(db, workspaceId, flowId);
    const version = (await newestVersionLike(db, workspaceId, flowId, flow)) ?? (await insertVersion(db, ctx, flowId, flow));
    if (deployed) {
        if (current?.id !== version.id) {
            await setDeployed(db, ctx, flowId, 'deploy', current?.id ?? null, version.id);
        }
        return;
    }

    const [last] = await db.query<{ id: string | null }>(
        'SELECT coalesce(to_version_id, from_version_id) AS id FROM deployment_history WHERE flow_id = $1 ORDER BY id DESC LIMIT 1',
        [flowId],
    );
    // a flow not deployed is exported at the version it was last deployed at: the tree's becomes it, deployed and undeployed
    if (last && last.id !== version.id && current?.id !== version.id) {
        await setDeployed(db, ctx, flowId, 'deploy', current?.id ?? null, version.id);
        current = version;
    }
    if (current) {
        await setDeployed(db, ctx, flowId, 'undeploy', current.id, null);
    }
}

async function importScripts(
    ctx: UseCaseContext,
    scripts: Entry<'script'>[],
    scriptFolders: Entry<'scriptFolder'>[],
    projectIds: Map<string, string>,
): Promise<void> {
    const { db, workspaceId, userId } = ctx;
    const projects = [...projectIds.values()];
    const existing = new Map(
        (
            await db.query<{ project_id: string; path: string; content: string }>(
                'SELECT project_id, path, content FROM scripts WHERE workspace_id = $1 AND project_id = ANY($2::uuid[])',
                [workspaceId, projects],
            )
        ).map(s => [`${s.project_id}/${s.path}`, s]),
    );
    const inTree = new Set<string>();
    for (const { text, entry } of scripts) {
        const projectId = projectIds.get(entry.project)!;
        const path = nfc(entry.path);
        const was = existing.get(`${projectId}/${path}`);
        inTree.add(`${projectId}/${path}`);
        if (!was) {
            await db.query(
                'INSERT INTO scripts (id, workspace_id, project_id, path, content, exports, updated_by) VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7)',
                [crypto.randomUUID(), workspaceId, projectId, path, text, exportsOf(text), userId],
            );
        } else if (was.content !== text) {
            await db.query(
                `UPDATE scripts SET content = $4, exports = $5::text::jsonb, revision = revision + 1, updated_by = $6, updated_at = now()
         WHERE workspace_id = $1 AND project_id = $2 AND path = $3`,
                [workspaceId, projectId, path, text, exportsOf(text), userId],
            );
        }
    }
    for (const [key, script] of existing) {
        if (!inTree.has(key)) {
            await db.query('DELETE FROM scripts WHERE workspace_id = $1 AND project_id = $2 AND path = $3', [
                workspaceId,
                script.project_id,
                script.path,
            ]);
        }
    }

    await db.query('DELETE FROM script_folders WHERE workspace_id = $1 AND project_id = ANY($2::uuid[])', [workspaceId, projects]);
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
