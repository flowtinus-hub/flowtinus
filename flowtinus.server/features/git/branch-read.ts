import { connectionFromYaml, isRepoId, projectFromYaml, repoEntry, repoFlowFromYaml, type ConnectionTypeName, type FlowFile, type RepoFlow, type RepoTriggers } from '@flowtinus/core';
import { activeFlow } from '#features/deployments/deployments';
import type { Flow } from '#features/flows/flow';
import type { FlowDraft } from '#features/flows/flow-draft';
import { withoutPinned } from '#features/pins/pins';
import type { Folder } from '#features/folders/folder';
import type { Project } from '#features/projects/project';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import { canEditBranch, currentBranch, editorOf } from './current-branch';
import { gitAccess, gitBranch, readGitConfig } from './git-config';
import { readHeads } from './git-heads';
import { GitError, withWorkspaceClone, type GitRemote } from './git-remote';
import type { RepoFiles } from './workspace-export';
import { overlayRows, workingRows, type WorkingRow } from './working-copy';

export type BranchFlow = Flow & {
    archivedAt: null;
    file: FlowFile;
    deployed: boolean;
    triggers: RepoTriggers;
    path: string;
    revision: number;
    conflict?: string;
};

export type BranchFolder = Folder & { archivedAt: null };

export type BranchScript = { path: string; content: string; revision: number; updatedBy: string | null; updatedAt: Date };

export type BranchConnection = { id: string; name: string; type: ConnectionTypeName; path: string };

export type WorkBranch = {
    branch: string;
    tip: string;
    editable: boolean;
    removed: boolean;
    lostTip: boolean;
    mayChange: boolean;
    slug: string;
    at: Date;
    tipFiles: RepoFiles;
    connections: BranchConnection[];
    projects: Project[];
    folders: BranchFolder[];
    flows: BranchFlow[];
    scripts: Map<string, BranchScript[]>;
    scriptFolders: Map<string, string[]>;
};

type Tip = { files: RepoFiles; at: Date; flows: Map<string, { text: string; read: RepoFlow | null }> };

const TIPS_KEPT = 32;
const tips = new Map<string, Promise<Tip>>();

function cachedTip(key: string, load: () => Promise<Tip>): Promise<Tip> {
    const kept = tips.get(key);
    if (kept) {
        tips.delete(key);
        tips.set(key, kept);
        return kept;
    }
    const loading = load();
    tips.set(key, loading);
    loading.catch(() => tips.delete(key));
    while (tips.size > TIPS_KEPT) {
        tips.delete(tips.keys().next().value!);
    }
    return loading;
}

async function slugOf(ctx: UseCaseContext): Promise<string> {
    const [row] = await ctx.db.query<{ slug: string }>('SELECT slug FROM workspaces WHERE id = $1', [ctx.workspaceId]);
    return row!.slug;
}

export async function onClone<T>(ctx: UseCaseContext, what: string, work: (remote: GitRemote) => Promise<T>): Promise<T> {
    const config = await readGitConfig(ctx.db, ctx.workspaceId);
    if (!config || !ctx.git) {
        throw new UseCaseFailure('unavailable', 'Git is on, but this server has no git options.');
    }
    const access = await gitAccess(ctx, config);
    if (!access.ok) {
        throw new UseCaseFailure(access.error.code, access.error.message);
    }
    try {
        return await withWorkspaceClone(ctx.git.clonesDir, ctx.workspaceId, access.value, work);
    } catch (e) {
        if (e instanceof GitError) {
            throw new UseCaseFailure('unavailable', `${what}: ${e.message}`);
        }
        throw e;
    }
}

function readTip(ctx: UseCaseContext, branch: string, sha: string, slug: string): Promise<Tip> {
    return cachedTip(`${ctx.workspaceId}:${sha}`, () =>
        onClone(ctx, `The branch ${branch} could not be read from git`, async remote => {
            // a head another server fetched: this server's clone may not have it yet
            if (!(await remote.hasCommit(sha))) {
                await remote.fetch(branch);
            }
            const files = await remote.files(sha, [slug, '.gitattributes']);
            const at = new Date((await remote.run(['show', '-s', '--format=%cI', sha])).trim());
            return { files, at, flows: new Map() };
        }),
    );
}

export async function filesAt(ctx: UseCaseContext, branch: string, sha: string): Promise<RepoFiles> {
    return (await readTip(ctx, branch, sha, await slugOf(ctx))).files;
}

function readFlow(tip: Tip, path: string, text: string, name: string): RepoFlow | null {
    const parsed = tip.flows.get(path);
    if (parsed?.text === text) {
        return parsed.read;
    }
    const read = repoFlowFromYaml(text, name);
    const value = read.ok && read.value.flow.id && isRepoId(read.value.flow.id) ? read.value : null;
    // the tip's own text only: a working copy's changes are parsed at each read
    if (tip.files[path] === text) {
        tip.flows.set(path, { text, read: value });
    }
    return value;
}

export function branchFolderId(projectId: string, names: string[]): string {
    const h = new Bun.CryptoHasher('sha256').update(`${projectId}/${names.join('/').toLowerCase()}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

const reads = new WeakMap<UseCaseContext, Promise<WorkBranch | null>>();

export function workBranch(ctx: UseCaseContext): Promise<WorkBranch | null> {
    let read = reads.get(ctx);
    if (!read) {
        read = readWorkBranch(ctx);
        reads.set(ctx, read);
    }
    return read;
}

export const forgetWorkBranch = (ctx: UseCaseContext) => reads.delete(ctx);

async function readWorkBranch(ctx: UseCaseContext): Promise<WorkBranch | null> {
    const [git, branch] = await Promise.all([gitBranch(ctx.db, ctx.workspaceId), currentBranch(ctx.db, ctx.workspaceId, ctx.userId)]);
    if (!git || branch === null || branch === git.branch) {
        return null;
    }
    const head = (await readHeads(ctx.db, ctx.workspaceId))?.heads.find(h => h.name === branch);
    if (!head) {
        throw new UseCaseFailure('conflict', `The branch ${branch} is not in the repository: pick another branch.`);
    }

    const slug = await slugOf(ctx);
    const [tip, rows, editor] = await Promise.all([
        readTip(ctx, branch, head.sha, slug),
        workingRows(ctx.db, ctx.workspaceId, branch),
        editorOf(ctx.db, ctx.workspaceId, ctx.userId),
    ]);
    const mayChange = canEditBranch(branch, git.branch, editor);
    const removed = head.removed === true;
    return {
        ...(await buildBranch(ctx, { branch, sha: head.sha, slug, tip, rows, editable: mayChange && !removed })),
        removed,
        lostTip: head.lostTip === true,
        mayChange,
    };
}

async function buildBranch(
    ctx: UseCaseContext,
    {
        branch,
        sha,
        slug,
        tip,
        rows,
        editable,
    }: { branch: string; sha: string; slug: string; tip: Tip; rows: WorkingRow[]; editable: boolean },
): Promise<Omit<WorkBranch, 'removed' | 'lostTip' | 'mayChange'>> {
    const files = overlayRows(tip.files, rows);
    const byPath = new Map(rows.map(r => [r.path, r]));
    const entries = Object.entries(files)
        .filter(([path]) => path.startsWith(`${slug}/`))
        .map(([path, text]) => ({ path, text, entry: repoEntry(path) }));

    const connections: BranchConnection[] = [];
    for (const { path, text, entry } of entries) {
        if (entry.kind === 'connection') {
            const read = connectionFromYaml(text);
            if (read.ok && isRepoId(read.value.id)) {
                connections.push({ id: read.value.id, name: entry.name, type: read.value.type, path });
            }
        }
    }

    const projects: Project[] = [];
    const projectIds = new Map<string, string>();
    for (const { text, entry } of entries) {
        if (entry.kind !== 'project') {
            continue;
        }
        const read = projectFromYaml(text);
        if (read.ok && isRepoId(read.value.id)) {
            projectIds.set(entry.project, read.value.id);
            projects.push({
                id: read.value.id,
                workspaceId: ctx.workspaceId,
                name: entry.project,
                description: read.value.description,
                icon: read.value.icon ?? 'folder',
                color: read.value.color ?? 'blue',
                createdAt: tip.at,
                deletedAt: null,
                deletedBy: null,
            });
        }
    }

    const folders = new Map<string, BranchFolder>();
    const folderOf = (projectId: string, names: string[]): string | null => {
        let parentId: string | null = null;
        for (let i = 1; i <= names.length; i++) {
            const id = branchFolderId(projectId, names.slice(0, i));
            if (!folders.has(id)) {
                folders.set(id, {
                    id,
                    workspaceId: ctx.workspaceId,
                    projectId,
                    parentId,
                    name: names[i - 1]!,
                    createdAt: tip.at,
                    deletedAt: null,
                    deletedBy: null,
                    removedAt: null,
                    removedBy: null,
                    archivedAt: null,
                });
            }
            parentId = id;
        }
        return parentId;
    };

    const flows: BranchFlow[] = [];
    const scripts = new Map<string, BranchScript[]>();
    const scriptFolders = new Map<string, string[]>();
    for (const { path, text, entry } of entries) {
        const projectId = 'project' in entry ? projectIds.get(entry.project) : undefined;
        if (!projectId) {
            continue;
        }
        const row = byPath.get(path);
        if (entry.kind === 'folder') {
            folderOf(projectId, entry.folders);
        } else if (entry.kind === 'flow') {
            const read = readFlow(tip, path, text, entry.name);
            if (!read) {
                continue;
            }
            flows.push({
                id: read.flow.id!,
                workspaceId: ctx.workspaceId,
                projectId,
                folderId: folderOf(projectId, entry.folders),
                name: entry.name,
                workerTag: 'default',
                createdAt: tip.at,
                updatedBy: row?.edited_by ?? null,
                updatedAt: row ? new Date(row.updated_at) : tip.at,
                deletedAt: null,
                deletedBy: null,
                deletedByCommit: null,
                removedAt: null,
                removedBy: null,
                archivedAt: null,
                file: { ...read.flow, name: entry.name },
                deployed: read.deployed,
                triggers: { schedules: read.schedules, webhooks: read.webhooks },
                path,
                revision: row?.revision ?? 0,
                ...(row?.conflict ? { conflict: row.conflict } : {}),
            });
        } else if (entry.kind === 'script') {
            const list = scripts.get(projectId) ?? [];
            list.push({
                path: entry.path,
                content: text,
                revision: row?.revision ?? 0,
                updatedBy: row?.edited_by ?? null,
                updatedAt: row ? new Date(row.updated_at) : tip.at,
            });
            scripts.set(projectId, list);
        } else if (entry.kind === 'scriptFolder') {
            scriptFolders.set(projectId, [...(scriptFolders.get(projectId) ?? []), entry.path]);
        }
    }

    const [known, knownProjects] = await Promise.all([
        ctx.db.query<{ id: string; worker_tag: string; created_at: Date }>(
            'SELECT id, worker_tag, created_at FROM flows WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
            [ctx.workspaceId, flows.map(f => f.id)],
        ),
        ctx.db.query<{ id: string; created_at: Date }>(
            'SELECT id, created_at FROM projects WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
            [ctx.workspaceId, projects.map(p => p.id)],
        ),
    ]);
    for (const row of known) {
        const flow = flows.find(f => f.id === row.id)!;
        flow.workerTag = row.worker_tag;
        flow.createdAt = new Date(row.created_at);
    }
    for (const row of knownProjects) {
        projects.find(p => p.id === row.id)!.createdAt = new Date(row.created_at);
    }
    for (const list of scripts.values()) {
        list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }

    return {
        branch,
        tip: sha,
        editable,
        slug,
        at: tip.at,
        tipFiles: tip.files,
        connections: connections.sort(byName),
        projects: projects.sort(byName),
        folders: [...folders.values()].sort(byName),
        flows: flows.sort(byName),
        scripts,
        scriptFolders,
    };
}

export const branchTree = (branch: WorkBranch, projectId: string): { folders: BranchFolder[]; flows: BranchFlow[] } => ({
    folders: branch.folders.filter(f => f.projectId === projectId),
    flows: branch.flows.filter(f => f.projectId === projectId),
});

export const branchFlow = (branch: WorkBranch, id: string) => branch.flows.find(f => f.id === id);

export const branchProject = (branch: WorkBranch, id: string) => branch.projects.find(p => p.id === id);

export const branchScripts = (branch: WorkBranch, projectId: string) => branch.scripts.get(projectId) ?? [];

export async function currentFlow(ctx: UseCaseContext, id: string): Promise<Flow | null> {
    const branch = await workBranch(ctx);
    return branch ? (branchFlow(branch, id) ?? null) : activeFlow(ctx, id);
}

export const branchDraft = (flow: BranchFlow): FlowDraft => ({
    flow: withoutPinned({ ...flow.file, id: flow.id, name: flow.name }),
    revision: flow.revision,
    ...(flow.conflict ? { conflict: flow.conflict } : {}),
});

export type ArchivedProject = Project & { deletedAt: Date; path: string };

export type ArchivedFolder = Folder & { deletedAt: Date; names: string[] };

export type ArchivedFlow = Flow & { deletedAt: Date; path: string; content: string };

export type BranchArchive = { projects: ArchivedProject[]; folders: ArchivedFolder[]; flows: ArchivedFlow[]; rows: WorkingRow[] };

export async function branchArchive(ctx: UseCaseContext, branch: WorkBranch): Promise<BranchArchive> {
    // a file is archived as its last deletion left it: an older path of it (before a rename) is not
    const newest = new Set<string>();
    const rows = (await workingRows(ctx.db, ctx.workspaceId, branch.branch))
        .filter(r => r.path.startsWith(`${branch.slug}/`) && r.deleted)
        .map(r => ({ ...r, updated_at: new Date(r.updated_at) }))
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .filter(r => {
            if (r.file_id !== null) {
                if (newest.has(r.file_id)) {
                    return false;
                }
                newest.add(r.file_id);
            }
            return r.content !== null;
        });
    const live = new Set([...branch.projects.map(p => p.id), ...branch.flows.map(f => f.id)]);
    const liveFolders = new Set(branch.folders.map(f => f.id));
    const projectIds = new Map(branch.projects.map(p => [p.name, p.id]));

    const projects: ArchivedProject[] = [];
    for (const row of rows) {
        const entry = repoEntry(row.path);
        if (entry.kind !== 'project' || projectIds.has(entry.project)) {
            continue;
        }
        const read = projectFromYaml(row.content!);
        if (read.ok && isRepoId(read.value.id) && !live.has(read.value.id) && !projects.some(p => p.id === read.value.id)) {
            projectIds.set(entry.project, read.value.id);
            projects.push({
                id: read.value.id,
                workspaceId: ctx.workspaceId,
                name: entry.project,
                description: read.value.description,
                icon: read.value.icon ?? 'folder',
                color: read.value.color ?? 'blue',
                createdAt: row.updated_at,
                deletedAt: row.updated_at,
                deletedBy: row.edited_by,
                path: row.path,
            });
        }
    }

    const folders = new Map<string, ArchivedFolder>();
    const archiveFolders = (projectId: string, names: string[], at: Date, by: string | null) => {
        for (let i = 1; i <= names.length; i++) {
            const id = branchFolderId(projectId, names.slice(0, i));
            const was = folders.get(id);
            if (liveFolders.has(id) || (was && was.deletedAt >= at)) {
                continue;
            }
            folders.set(id, {
                id,
                workspaceId: ctx.workspaceId,
                projectId,
                parentId: i > 1 ? branchFolderId(projectId, names.slice(0, i - 1)) : null,
                name: names[i - 1]!,
                createdAt: at,
                deletedAt: at,
                deletedBy: by,
                removedAt: null,
                removedBy: null,
                names: names.slice(0, i),
            });
        }
    };

    const flows: ArchivedFlow[] = [];
    for (const row of rows) {
        const entry = repoEntry(row.path);
        const projectId = 'project' in entry ? projectIds.get(entry.project) : undefined;
        if (!projectId) {
            continue;
        }
        if (entry.kind === 'flow') {
            const read = repoFlowFromYaml(row.content!, entry.name);
            const id = read.ok ? read.value.flow.id : undefined;
            if (!id || !isRepoId(id) || live.has(id) || flows.some(f => f.id === id)) {
                continue;
            }
            flows.push({
                id,
                workspaceId: ctx.workspaceId,
                projectId,
                folderId: entry.folders.length > 0 ? branchFolderId(projectId, entry.folders) : null,
                name: entry.name,
                workerTag: 'default',
                createdAt: row.updated_at,
                updatedBy: row.edited_by,
                updatedAt: row.updated_at,
                deletedAt: row.updated_at,
                deletedBy: row.edited_by,
                deletedByCommit: null,
                removedAt: null,
                removedBy: null,
                path: row.path,
                content: row.content!,
            });
            archiveFolders(projectId, entry.folders, row.updated_at, row.edited_by);
        } else if (entry.kind === 'folder') {
            archiveFolders(projectId, entry.folders, row.updated_at, row.edited_by);
        }
    }

    return { projects, folders: [...folders.values()], flows, rows };
}
