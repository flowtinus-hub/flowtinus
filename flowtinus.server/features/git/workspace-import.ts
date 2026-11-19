import { inArray } from 'drizzle-orm';
import { connectionFromYaml, isRepoId, projectFromYaml, repoEntry, repoPath, repoFlowFromYaml, validateWorkspaceTree, type FlowFile, type RepoEntry, type TreeIssue, type TreeValidation, type WorkspaceTree } from '@flowtinus/core';
import { ConnectionRepository } from '#features/connections/connection-store';
import { contentHash, currentDeployment, insertVersion, lockFlowDeployments, newestVersionLike, setDeployed, undeployArchived, type Actor } from '#features/deployments/deployments';
import { flows as flowsTable } from '#features/flows/flow';
import { flowRepoPath } from '#features/flows/flow-draft';
import { FlowRepository, FolderRepository, loadTree } from '#features/folders/project-tree';
import { archiveProject } from '#features/projects/archive-project/archive-project-handler';
import { ProjectRepository } from '#features/projects/project-repository';
import { saveBlob } from '#features/scripts/script-store';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { ENVIRONMENT_BRANCH, followGit, overlay, scriptFileId, writeFile, type RenamedDraft } from './working-copy';
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
export type { RenamedDraft };

// a reconcile (with its commit) archives what git removed and renames a new flow whose path git takes; turning git on
// deletes the connections and refuses the clash instead, as its preview said
export type ImportOptions = { commit?: string; by?: string | null };

/**
 * The tree applied to the server. With a commit (the reconcile), what is deployed follows `files` (the branch's tip),
 * while the names, folders, projects and connections follow the tip with the working copy over it: an uncommitted
 * rename or archive outlives the commit.
 */
export async function importWorkspace(
    ctx: UseCaseContext,
    slug: string,
    files: RepoFiles,
    options: ImportOptions = {},
): Promise<{ renamedDrafts: RenamedDraft[] }> {
    if (!options.commit) {
        const clashes = await clashingDrafts(ctx.db, ctx.workspaceId, slug, files);
        if (clashes[0]) {
            throw new ImportConflict(clashMessage(clashes[0]));
        }
    }

    const renamedDrafts = options.commit ? await followGit(ctx.db, ctx.workspaceId, files, options.commit) : [];
    const working = options.commit ? await overlay(ctx.db, ctx.workspaceId, files) : files;
    await importStructure(ctx, slug, working, { keep: Boolean(options.commit), tip: files, commit: options.commit ?? null });
    if (!options.commit) {
        await keepOnlyDrafts(ctx);
    }
    await importDeployed(ctx, slug, files, options);
    return { renamedDrafts };
}

/**
 * Git replacing the server (turning git on): of the working copy, only the flows' drafts stay, each at its flow's path
 * now; the rest is what the server had, which git replaces (the scripts are rewritten by the import).
 */
async function keepOnlyDrafts(ctx: UseCaseContext): Promise<void> {
    const { db, workspaceId } = ctx;
    const live = new Map((await new FlowRepository(db, workspaceId).findMany()).map(f => [f.id, f]));
    const rows = await db.query<{ path: string; file_id: string | null; deleted: boolean; content: string | null; revision: number }>(
        'SELECT path, file_id, deleted, content, revision FROM working_copy WHERE workspace_id = $1 AND branch = $2',
        [workspaceId, ENVIRONMENT_BRANCH],
    );
    const drafts = rows.filter(r => r.file_id && live.has(r.file_id) && !r.deleted && r.content !== null);
    await db.query("DELETE FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND NOT (coalesce(position('/' in file_id), 0) > 0)", [
        workspaceId,
        ENVIRONMENT_BRANCH,
    ]);
    for (const draft of drafts) {
        const flow = live.get(draft.file_id!)!;
        await writeFile(db, workspaceId, {
            path: await flowRepoPath(db, workspaceId, flow),
            content: draft.content!,
            fileId: flow.id,
            userId: ctx.userId,
            revision: draft.revision,
        });
    }
}

/**
 * The names and places of things as `working` has them: connections declared, projects, folders, flows, script folders.
 * `keep`: what is not there is archived (a connection keeps its configuration), as a reconcile does; else, as turning
 * git on, a connection not there is deleted and a flow never deployed stays. `tip`: what git has, to tell a flow git
 * removed from one only archived here.
 */
export async function importStructure(
    ctx: UseCaseContext,
    slug: string,
    working: RepoFiles,
    options: { keep: boolean; tip?: RepoFiles; commit?: string | null },
): Promise<void> {
    const entries = entriesOf(working, slug);
    await importConnections(ctx, entries.connections, { keep: options.keep });
    const projectIds = await importProjects(ctx, entries.projects);
    const folders = new ProjectFolders(ctx, projectIds);
    for (const { entry } of entries.folders) {
        await folders.folderOf(entry.project, entry.folders);
    }
    const inTip = options.tip ? new Set(flowIdsOf(entriesOf(options.tip, slug).flows)) : null;
    await importFlowPlaces(ctx, entries.flows, projectIds, folders, { keep: options.keep, inTip, commit: options.commit ?? null });
    await folders.archiveUnused();

    const projects = [...projectIds.values()];
    await ctx.db.query('DELETE FROM script_folders WHERE workspace_id = $1 AND project_id = ANY($2::uuid[])', [ctx.workspaceId, projects]);
    for (const { entry } of entries.scriptFolders) {
        await ctx.db.query('INSERT INTO script_folders (workspace_id, project_id, path) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
            ctx.workspaceId,
            projectIds.get(entry.project),
            nfc(entry.path),
        ]);
    }

    const kept = new Set(projectIds.values());
    for (const { id } of await new ProjectRepository(ctx.db, ctx.workspaceId).findMany()) {
        if (!kept.has(id)) {
            await archiveProject(ctx.db, ctx, id);
        }
    }
}

const flowIdsOf = (entries: Entry<'flow'>[]) => entries.map(({ text, entry }) => read(repoFlowFromYaml(text, nfc(entry.name))).flow.id!);

// two of them trading names would collide on the way: each one renamed takes its id as a name first
const renameToIds = (db: Database, table: 'connections' | 'flows', workspaceId: string, ids: string[]) =>
    db.query(`UPDATE ${table} SET name = id::text WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [workspaceId, ids]);

async function importConnections(ctx: UseCaseContext, entries: Entry<'connection'>[], options: { keep: boolean }): Promise<void> {
    const { db, workspaceId, userId } = ctx;
    const repository = new ConnectionRepository(db, workspaceId);
    const declared = entries.map(({ text, entry }) => ({ ...read(connectionFromYaml(text)), name: nfc(entry.name) }));
    const ids = new Set(declared.map(c => c.id));
    const existing = new Map<string, { name: string; type: string; config: Record<string, string> }>();
    const archived: string[] = [];
    for (const connection of options.keep ? await repository.findAll() : await repository.findMany()) {
        if (ids.has(connection.id)) {
            existing.set(connection.id, connection.deletedAt ? { ...connection, name: connection.id } : connection);
            if (connection.deletedAt) {
                archived.push(connection.id);
            }
        } else if (!options.keep) {
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
        if (was.name !== name || was.description !== project.description || was.icon !== project.icon || was.color !== project.color) {
            await repository.update(project.id, { name, description: project.description, icon: project.icon, color: project.color });
        }
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

async function importFlowPlaces(
    ctx: UseCaseContext,
    entries: Entry<'flow'>[],
    projectIds: Map<string, string>,
    folders: ProjectFolders,
    options: { keep: boolean; inTip: Set<string> | null; commit: string | null },
): Promise<void> {
    const { db, workspaceId, userId } = ctx;
    const inTree = entries.map(({ text, entry }) => ({ entry, ...read(repoFlowFromYaml(text, nfc(entry.name))) }));
    const ids = inTree.map(f => f.flow.id!);
    // a flow leaves when it was a file: committed (a version), or in the working copy (kept: a new one discarded); one
    // that never was either (none should be) stays as it is rather than be archived unseen
    const leaving = await db.query<{ id: string }>(
        `SELECT f.id FROM flows f WHERE f.workspace_id = $1 AND f.deleted_at IS NULL AND NOT (f.id = ANY($2::uuid[]))
       AND (EXISTS (SELECT 1 FROM flow_versions v WHERE v.flow_id = f.id)
         OR ($3 AND EXISTS (SELECT 1 FROM working_copy w WHERE w.workspace_id = f.workspace_id AND w.branch = '' AND w.file_id = f.id::text)))`,
        [workspaceId, ids, options.keep],
    );
    const repository = new FlowRepository(db, workspaceId);
    for (const { id } of leaving) {
        const byCommit = options.commit && options.inTip && !options.inTip.has(id) ? options.commit : null;
        await repository.update(id, { deletedAt: new Date(), deletedBy: userId, deletedByCommit: byCommit });
    }
    if (!options.keep) {
        await undeployArchived(
            db,
            { workspaceId, userId },
            leaving.map(f => f.id),
        );
    }

    // removed ones included: a flow git brings back comes back with its history
    const existing = new Set(
        (await db.query<{ id: string }>('SELECT id FROM flows WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, ids])).map(
            f => f.id,
        ),
    );
    await renameToIds(db, 'flows', workspaceId, [...existing]);

    for (const { entry, flow } of inTree) {
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
            await repository.insert({ id, projectId, folderId, name: flow.name, updatedBy: userId });
        }
    }
}

/** what is deployed as the tip has it: the flows' versions, and with a commit the deployed script set */
async function importDeployed(ctx: UseCaseContext, slug: string, files: RepoFiles, options: ImportOptions): Promise<void> {
    const { db, workspaceId, userId } = ctx;
    const commit = options.commit ?? null;
    const by = { workspaceId, userId: commit ? (options.by ?? null) : userId };
    const entries = entriesOf(files, slug);
    const inTree = entries.flows.map(({ text, entry }) => read(repoFlowFromYaml(text, nfc(entry.name))));
    const ids = inTree.map(f => f.flow.id!);
    if (commit) {
        const gone = await db.query<{ flow_id: string }>(
            'SELECT flow_id FROM deployments WHERE workspace_id = $1 AND NOT (flow_id = ANY($2::uuid[]))',
            [workspaceId, ids],
        );
        await undeployArchived(
            db,
            by,
            gone.map(f => f.flow_id),
            commit,
        );
    }
    const known = new Set(
        (await db.query<{ id: string }>('SELECT id FROM flows WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, ids])).map(
            f => f.id,
        ),
    );
    for (const { flow, deployed } of inTree) {
        if (known.has(flow.id!)) {
            await deployAsInTree(db, by, flow.id!, flow, deployed, commit);
        }
    }

    const projectIds = new Map(entries.projects.map(({ text, entry }) => [entry.project, read(projectFromYaml(text)).id]));
    await importScripts(ctx, entries.scripts, projectIds, commit);
}

async function deployAsInTree(
    db: Database,
    by: Actor,
    flowId: string,
    flow: FlowFile,
    deployed: boolean,
    commit: string | null,
): Promise<void> {
    const { workspaceId } = by;
    await lockFlowDeployments(db, flowId);
    const current = await currentDeployment(db, workspaceId, flowId);
    if (deployed) {
        const version = (await newestVersionLike(db, workspaceId, flowId, flow)) ?? (await insertVersion(db, by, flowId, flow, commit));
        if (current?.id !== version.id) {
            await setDeployed(db, by, flowId, 'deploy', current?.id ?? null, version.id, commit);
        }
        return;
    }

    if (current) {
        await setDeployed(db, by, flowId, 'undeploy', current.id, null, commit);
    }
    const [inRepo] = await flowsInRepo(db, workspaceId, [flowId]);
    if (inRepo?.content_hash !== contentHash(flow)) {
        await insertVersion(db, by, flowId, flow, commit);
    }
}

/**
 * With a commit, the deployed script set becomes the tip's (the working copy over it is the scripts being edited);
 * without one (turning git on, git replacing the server), the scripts being edited become the tree's.
 */
async function importScripts(
    ctx: UseCaseContext,
    scripts: Entry<'script'>[],
    projectIds: Map<string, string>,
    commit: string | null,
): Promise<void> {
    const { db, workspaceId, userId } = ctx;
    const inTree = new Map<string, { projectId: string; path: string; text: string }>();
    for (const { text, entry } of scripts) {
        const projectId = projectIds.get(entry.project)!;
        const path = nfc(entry.path);
        inTree.set(scriptFileId(projectId, path), { projectId, path, text });
    }

    if (!commit) {
        const projects = [...projectIds.values()];
        const rows = await db.query<{ file_id: string; path: string }>(
            `SELECT file_id, path FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND file_id IS NOT NULL
         AND position('/' in file_id) > 0 AND split_part(file_id, '/', 1) = ANY($3::text[])`,
            [workspaceId, ENVIRONMENT_BRANCH, projects],
        );
        for (const row of rows.filter(r => !inTree.has(r.file_id))) {
            await db.query('DELETE FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND path = $3', [
                workspaceId,
                ENVIRONMENT_BRANCH,
                row.path,
            ]);
        }
        const slug = (await db.query<{ slug: string }>('SELECT slug FROM workspaces WHERE id = $1', [workspaceId]))[0]!.slug;
        const names = new Map([...projectIds].map(([name, id]) => [id, name]));
        for (const [fileId, script] of inTree) {
            const path = repoPath.script(slug, names.get(script.projectId)!, script.path);
            await writeFile(db, workspaceId, { path, content: script.text, fileId, userId });
        }
        return;
    }

    const deployed = await db.query<{ project_id: string; path: string; hash: string }>(
        'SELECT project_id, path, hash FROM deployed_scripts WHERE workspace_id = $1',
        [workspaceId],
    );
    for (const [, { projectId, path, text }] of inTree) {
        const hash = await saveBlob(db, workspaceId, text);
        if (deployed.find(d => d.project_id === projectId && d.path === path)?.hash !== hash) {
            await db.query(
                `INSERT INTO deployed_scripts (workspace_id, project_id, path, hash, commit_sha) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (project_id, path) DO UPDATE SET workspace_id = $1, hash = $4, commit_sha = $5`,
                [workspaceId, projectId, path, hash, commit],
            );
        }
    }
    for (const script of deployed.filter(d => !inTree.has(scriptFileId(d.project_id, d.path)))) {
        await db.query('DELETE FROM deployed_scripts WHERE workspace_id = $1 AND project_id = $2 AND path = $3', [
            workspaceId,
            script.project_id,
            script.path,
        ]);
    }
}

function read<T>(result: { ok: true; value: T } | { ok: false; errors: string[] }): T {
    if (!result.ok) {
        throw new Error(`A file validateImport refuses: ${result.errors.join(' ')}`);
    }
    return result.value;
}
