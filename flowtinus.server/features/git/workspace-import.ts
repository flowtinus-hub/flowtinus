import { and, eq, inArray, isNull } from 'drizzle-orm';
import { connectionFromYaml, isRepoId, projectFromYaml, repoEntry, repoFlowFromYaml, validateWorkspaceTree, type FlowFile, type RepoEntry, type TreeIssue, type TreeValidation, type WorkspaceTree } from '@flowtinus/core';
import { ConnectionRepository } from '#features/connections/connection-store';
import { contentHash, currentDeployment, insertVersion, lockFlowDeployments, newestVersionLike, setDeployed, undeployArchived } from '#features/deployments/deployments';
import { flows as flowsTable } from '#features/flows/flow';
import type { StoredDraft } from '#features/flows/flow-draft';
import { FlowRepository, FolderRepository, loadTree } from '#features/folders/project-tree';
import { archiveProject } from '#features/projects/archive-project/archive-project-handler';
import { ProjectRepository } from '#features/projects/project-repository';
import { exportsOf } from '#features/scripts/script-store';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { GitRemote } from './git-remote';
import { flowsInRepo, type RepoFiles } from './workspace-export';

export const readBranchWorkspace = (remote: GitRemote, commit: string, slug: string): Promise<RepoFiles> =>
    remote.files(commit, [slug, '.gitattributes']);

export const holdsWorkspace = (files: RepoFiles, slug: string) => Object.keys(files).some(path => path.startsWith(`${slug}/`));

export async function isWorkspaceEmpty(db: Database, workspaceId: string): Promise<boolean> {
    const [row] = await db.query<{ empty: boolean }>(
        'SELECT NOT EXISTS (SELECT 1 FROM flows WHERE workspace_id = $1 AND removed_at IS NULL) AS empty',
        [workspaceId],
    );
    return row!.empty;
}

export async function importEnvironment(db: Database, workspaceId: string): Promise<WorkspaceTree['environment']> {
    const [connections, secrets, variables] = await Promise.all([
        // a connection only declared (it came from git) has an empty configuration: it is not configured here
        db.query<{ id: string }>(`SELECT id FROM connections WHERE workspace_id = $1 AND deleted_at IS NULL AND config <> '{}'::jsonb`, [
            workspaceId,
        ]),
        db.query<{ name: string }>('SELECT name FROM secrets WHERE workspace_id = $1', [workspaceId]),
        db.query<{ name: string }>('SELECT name FROM variables WHERE workspace_id = $1', [workspaceId]),
    ]);
    return { connections: connections.map(c => c.id), secrets: secrets.map(s => s.name), variables: variables.map(v => v.name) };
}

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

const idOf = <T extends { id?: string }>(result: { ok: true; value: T } | { ok: false }) => (result.ok ? result.value.id : undefined);

function idsOf(files: RepoFiles, slug: string): { path: string; id: string }[] {
    const { connections, projects, flows } = entriesOf(files, slug);
    return [
        ...connections.map(e => ({ path: e.path, id: idOf(connectionFromYaml(e.text)) })),
        ...projects.map(e => ({ path: e.path, id: idOf(projectFromYaml(e.text)) })),
        ...flows.map(e => {
            const read = repoFlowFromYaml(e.text, e.entry.name);
            return { path: e.path, id: read.ok ? read.value.flow.id : undefined };
        }),
    ].filter((e): e is { path: string; id: string } => e.id !== undefined && isRepoId(e.id));
}

export async function validateImport(db: Database, workspaceId: string, slug: string, files: RepoFiles): Promise<TreeValidation> {
    const validation = validateWorkspaceTree({ workspace: slug, files, environment: await importEnvironment(db, workspaceId) });
    const ids = idsOf(files, slug);
    const taken = new Set(
        (
            await db.query<{ id: string }>(
                `SELECT id FROM projects WHERE id = ANY($2::uuid[]) AND workspace_id <> $1
         UNION SELECT id FROM flows WHERE id = ANY($2::uuid[]) AND workspace_id <> $1
         UNION SELECT id FROM connections WHERE id = ANY($2::uuid[]) AND workspace_id <> $1`,
                [workspaceId, ids.map(e => e.id)],
            )
        ).map(row => row.id),
    );
    const errors = ids
        .filter(e => taken.has(e.id))
        .map(e => ({ path: e.path, message: `The id "${e.id}" is already used by another workspace.` }));
    return { errors: [...validation.errors, ...errors], warnings: validation.warnings };
}

const nfc = (name: string) => name.normalize('NFC');

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type LiveFolder = { id: string; parentId: string | null; name: string };

async function liveFolders(db: Database, workspaceId: string, projectId: string): Promise<LiveFolder[]> {
    const tree = await loadTree(db, workspaceId, projectId);
    return tree.folders.filter(f => f.archivedAt === null).map(f => ({ id: f.id, parentId: f.parentId, name: f.name }));
}

function folderAt(folders: LiveFolder[], names: string[]): string | null | undefined {
    let parentId: string | null = null;
    for (const name of names) {
        const folder = folders.find(f => f.parentId === parentId && sameName(f.name, name));
        if (!folder) {
            return undefined;
        }
        parentId = folder.id;
    }
    return parentId;
}

type DraftOnly = { id: string; project_id: string; folder_id: string | null; name: string };

type DraftClash = { path: string; flowName: string; draft: DraftOnly };

async function clashingDrafts(db: Database, workspaceId: string, slug: string, files: RepoFiles): Promise<DraftClash[]> {
    const { projects, flows } = entriesOf(files, slug);
    const projectIds = new Map(projects.map(({ text, entry }) => [entry.project, idOf(projectFromYaml(text))]));
    const inTree = flows.flatMap(({ path, text, entry }) => {
        const read = repoFlowFromYaml(text, nfc(entry.name));
        return read.ok ? [{ path, entry, name: read.value.flow.name, id: read.value.flow.id! }] : [];
    });
    const drafts = await db.query<DraftOnly>(
        `SELECT id, project_id, folder_id, name FROM flows f WHERE workspace_id = $1 AND deleted_at IS NULL AND NOT (id::text = ANY($2::text[]))
       AND NOT EXISTS (SELECT 1 FROM flow_versions v WHERE v.flow_id = f.id)`,
        [workspaceId, inTree.map(f => f.id)],
    );

    const clashes: DraftClash[] = [];
    const folders = new Map<string, LiveFolder[]>();
    for (const flow of inTree) {
        const projectId = projectIds.get(flow.entry.project);
        const named = drafts.filter(d => d.project_id === projectId && sameName(d.name, flow.name));
        if (!projectId || named.length === 0) {
            continue;
        }

        const live = folders.get(projectId) ?? (await liveFolders(db, workspaceId, projectId));
        folders.set(projectId, live);
        const folderId = folderAt(live, flow.entry.folders.map(nfc));
        const taken = folderId === undefined ? undefined : named.find(d => d.folder_id === folderId);
        if (taken) {
            clashes.push({ path: flow.path, flowName: flow.entry.name, draft: taken });
        }
    }
    return clashes;
}

const clashMessage = ({ flowName, draft }: DraftClash) =>
    `The flow ${flowName} in git has the name of a draft here, ${draft.name}: rename the draft first.`;

export const draftClashes = async (db: Database, workspaceId: string, slug: string, files: RepoFiles): Promise<TreeIssue[]> =>
    (await clashingDrafts(db, workspaceId, slug, files)).map(clash => ({ path: clash.path, message: clashMessage(clash) }));

export class ImportConflict extends Error {}

export function issueFields(issues: TreeIssue[]): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const { path, message } of issues) {
        fields[path] = fields[path] ? `${fields[path]}\n${message}` : message;
    }
    return fields;
}

export type RenamedDraft = { id: string; from: string; to: string };

// a reconcile (with its commit) archives what git removed and renames a draft-only flow whose name git takes;
// turning git on deletes the connections and refuses the clash instead, as its preview said
export type ImportOptions = { commit?: string };

export async function importWorkspace(
    ctx: UseCaseContext,
    slug: string,
    files: RepoFiles,
    options: ImportOptions = {},
): Promise<{ renamedDrafts: RenamedDraft[] }> {
    const clashes = await clashingDrafts(ctx.db, ctx.workspaceId, slug, files);
    if (!options.commit && clashes[0]) {
        throw new ImportConflict(clashMessage(clashes[0]));
    }

    const entries = entriesOf(files, slug);
    const renamedDrafts = await renameDrafts(ctx, clashes, entries.flows);
    await importConnections(ctx, entries.connections, options);
    const projectIds = await importProjects(ctx, entries.projects);
    const folders = new ProjectFolders(ctx, projectIds);
    for (const { entry } of entries.folders) {
        await folders.folderOf(entry.project, entry.folders);
    }
    await importFlows(ctx, entries.flows, projectIds, folders, options);
    await folders.archiveUnused();
    await importScripts(ctx, entries.scripts, entries.scriptFolders, projectIds);

    const kept = new Set(projectIds.values());
    for (const { id } of await new ProjectRepository(ctx.db, ctx.workspaceId).findMany()) {
        if (!kept.has(id)) {
            await archiveProject(ctx.db, ctx, id);
        }
    }
    return { renamedDrafts };
}

async function renameDrafts(ctx: UseCaseContext, clashes: DraftClash[], inTree: Entry<'flow'>[]): Promise<RenamedDraft[]> {
    const repository = new FlowRepository(ctx.db, ctx.workspaceId);
    const renamed: RenamedDraft[] = [];
    for (const { draft } of clashes) {
        const siblings = await repository.findMany(
            and(
                eq(flowsTable.projectId, draft.project_id),
                draft.folder_id ? eq(flowsTable.folderId, draft.folder_id) : isNull(flowsTable.folderId),
            ),
        );
        const taken = new Set([...siblings.map(f => f.name), ...inTree.map(f => nfc(f.entry.name))].map(name => name.toLowerCase()));
        let name = `${draft.name} (draft)`;
        for (let n = 2; taken.has(name.toLowerCase()); n++) {
            name = `${draft.name} (draft ${n})`;
        }
        await repository.update(draft.id, { name, updatedBy: ctx.userId, updatedAt: new Date() });
        renamed.push({ id: draft.id, from: draft.name, to: name });
    }
    return renamed;
}

// two of them trading names would collide on the way: each one renamed takes its id as a name first
const renameToIds = (db: Database, table: 'connections' | 'flows', workspaceId: string, ids: string[]) =>
    db.query(`UPDATE ${table} SET name = id::text WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, ids]);

async function importConnections(ctx: UseCaseContext, entries: Entry<'connection'>[], options: ImportOptions): Promise<void> {
    const { db, workspaceId, userId } = ctx;
    const repository = new ConnectionRepository(db, workspaceId);
    const declared = entries.map(({ text, entry }) => ({ ...read(connectionFromYaml(text)), name: nfc(entry.name) }));
    const ids = new Set(declared.map(c => c.id));
    const existing = new Map<string, { name: string; type: string; config: Record<string, string> }>();
    const archived: string[] = [];
    for (const connection of options.commit ? await repository.findAll() : await repository.findMany()) {
        if (ids.has(connection.id)) {
            existing.set(connection.id, connection.deletedAt ? { ...connection, name: connection.id } : connection);
            if (connection.deletedAt) {
                archived.push(connection.id);
            }
        } else if (!options.commit) {
            await repository.remove(connection.id);
        } else if (!connection.deletedAt) {
            await repository.softDelete(connection.id, userId);
        }
    }
    await db.query(
        'UPDATE connections SET name = id::text, deleted_at = NULL, deleted_by = NULL WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
        [workspaceId, archived],
    );

    await renameToIds(
        db,
        'connections',
        workspaceId,
        declared.filter(c => existing.has(c.id) && existing.get(c.id)!.name !== c.name).map(c => c.id),
    );
    for (const { id, name, type } of declared) {
        const was = existing.get(id);
        if (!was) {
            await repository.insert({ id, name, type, config: {}, updatedBy: userId });
        } else if (was.name !== name || was.type !== type) {
            const config = was.type === type ? was.config : {};
            await repository.update(id, { name, type, config, updatedBy: userId, updatedAt: new Date() });
        }
    }
}

async function importProjects(ctx: UseCaseContext, entries: Entry<'project'>[]): Promise<Map<string, string>> {
    const repository = new ProjectRepository(ctx.db, ctx.workspaceId);
    const existing = new Map((await repository.findAll()).map(p => [p.id, p]));
    const projectIds = new Map<string, string>();
    for (const { text, entry } of entries) {
        const project = read(projectFromYaml(text));
        const name = nfc(entry.project);
        projectIds.set(entry.project, project.id);
        const was = existing.get(project.id);
        if (!was) {
            await repository.insert({ ...project, name });
            continue;
        }

        if (was.deletedAt) {
            await repository.restore(project.id);
        }
        await repository.update(project.id, { name, description: project.description, icon: project.icon, color: project.color });
    }
    return projectIds;
}

class ProjectFolders {
    private readonly live = new Map<string, LiveFolder[]>();
    private readonly used = new Set<string>();

    constructor(
        private readonly ctx: UseCaseContext,
        private readonly projectIds: Map<string, string>,
    ) {}

    private async of(projectId: string): Promise<LiveFolder[]> {
        const folders = this.live.get(projectId) ?? (await liveFolders(this.ctx.db, this.ctx.workspaceId, projectId));
        this.live.set(projectId, folders);
        return folders;
    }

    async folderOf(project: string, names: string[]): Promise<string | null> {
        const projectId = this.projectIds.get(project)!;
        const folders = await this.of(projectId);
        const repository = new FolderRepository(this.ctx.db, this.ctx.workspaceId);
        let parentId: string | null = null;
        for (const name of names.map(nfc)) {
            let folder = folders.find(f => f.parentId === parentId && sameName(f.name, name));
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

    // a folder no path reached stays while a live flow is in it or below it: a draft never deployed
    async archiveUnused(): Promise<void> {
        const projectIds = [...this.projectIds.values()];
        for (const projectId of projectIds) {
            await this.of(projectId);
        }
        const live = await new FlowRepository(this.ctx.db, this.ctx.workspaceId).findMany(inArray(flowsTable.projectId, projectIds));
        const withFlows = new Set(live.map(f => f.folderId));
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
    options: ImportOptions,
): Promise<void> {
    const { db, workspaceId, userId } = ctx;
    const commit = options.commit ?? null;
    const inTree = entries.map(({ text, entry }) => ({ entry, ...read(repoFlowFromYaml(text, nfc(entry.name))) }));
    const ids = inTree.map(f => f.flow.id!);
    const leaving = await db.query<{ id: string }>(
        `SELECT f.id FROM flows f WHERE f.workspace_id = $1 AND f.deleted_at IS NULL AND NOT (f.id = ANY($2::uuid[]))
       AND EXISTS (SELECT 1 FROM flow_versions v WHERE v.flow_id = f.id)`,
        [workspaceId, ids],
    );
    const repository = new FlowRepository(db, workspaceId);
    for (const { id } of leaving) {
        await repository.update(id, { deletedAt: new Date(), deletedBy: userId, deletedByCommit: commit });
    }
    await undeployArchived(
        db,
        ctx,
        leaving.map(f => f.id),
        commit,
    );

    // removed ones included: a flow git brings back comes back with its history
    const existing = new Set(
        (await db.query<{ id: string }>('SELECT id FROM flows WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, ids])).map(
            f => f.id,
        ),
    );
    await renameToIds(db, 'flows', workspaceId, [...existing]);

    for (const { entry, flow, deployed } of inTree) {
        const id = flow.id!;
        const projectId = projectIds.get(entry.project)!;
        const folderId = await folders.folderOf(entry.project, entry.folders);
        if (existing.has(id)) {
            await db.query(
                `UPDATE flows SET project_id = $3, folder_id = $4, name = $5, deleted_at = NULL, deleted_by = NULL, deleted_by_commit = NULL,
           removed_at = NULL, removed_by = NULL, updated_by = $6, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
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

        await deployAsInTree(ctx, id, flow, deployed, commit);
    }
}

async function deployAsInTree(
    ctx: UseCaseContext,
    flowId: string,
    flow: FlowFile,
    deployed: boolean,
    commit: string | null,
): Promise<void> {
    const { db, workspaceId } = ctx;
    await lockFlowDeployments(db, flowId);
    const current = await currentDeployment(db, workspaceId, flowId);
    if (deployed) {
        const version = (await newestVersionLike(db, workspaceId, flowId, flow)) ?? (await insertVersion(db, ctx, flowId, flow, commit));
        if (current?.id !== version.id) {
            await setDeployed(db, ctx, flowId, 'deploy', current?.id ?? null, version.id, commit);
        }
        return;
    }

    if (current) {
        await setDeployed(db, ctx, flowId, 'undeploy', current.id, null, commit);
    }
    const [inRepo] = await flowsInRepo(db, workspaceId, [flowId]);
    if (inRepo?.content_hash !== contentHash(flow)) {
        await insertVersion(db, ctx, flowId, flow, commit);
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
