import { canMoveFolder, connectionToYaml, flowWithScriptsMoved, folderPath, insideScriptFolder, isFolderVisible, movedScriptImports, movedScriptPath, handleHolder, handleOf, scriptImportPrefix, newFlowFile, projectToYaml, repoFlowToYaml, repoPath, type ConnectionTypeName, type FlowFile, type RepoTriggers } from '@flowtinus/core';
import { and, eq } from 'drizzle-orm';
import { connections, toConnectionView, type ConnectionView } from '#features/connections/connection';
import { checkProfile, ConnectionRepository, usedSecrets } from '#features/connections/connection-store';
import { nameInTree, pathTooLong, toFlowView, toFolderView, type FlowView, type FolderView } from '#features/folders/project-tree';
import { handleTaken, toProjectView, type ProjectView } from '#features/projects/project-fields';
import { ProjectRepository } from '#features/projects/project-repository';
import { allFolders, pathIssueIn } from '#features/scripts/script-store';
import { insertSecret } from '#features/secrets/secret-store';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { branchArchive, branchFlow, branchFolderId, branchProject, branchTree, type BranchConnection, type BranchFlow, type WorkBranch } from './branch-read';
import { changeBranch, lockBranch, refuseReadOnly, saveBranchFile } from './branch-write';
import { gitBranch } from './git-config';
import type { RepoFiles } from './workspace-export';
import { scriptFileId } from './working-copy';

const notFound = () => fail('not-found', 'Flow not found.');

const changedElsewhere = (what: string) => fail('conflict', `This ${what} was changed elsewhere. Reload it to see the latest version.`);

function projectOn(branch: WorkBranch, projectId: string) {
    const project = branchProject(branch, projectId);
    if (!project) {
        return null;
    }
    const scripts = branch.scripts.get(projectId) ?? [];
    return {
        project,
        tree: branchTree(branch, projectId),
        listing: { scripts, folders: branch.scriptFolders.get(projectId) ?? [] },
        names: {
            project: project.name,
            scripts: { scripts: scripts.map(s => s.path), folders: branch.scriptFolders.get(projectId) ?? [] },
        },
    };
}

const flowPath = (branch: WorkBranch, project: string, folderId: string | null, name: string) =>
    repoPath.flow(
        branch.handle,
        project,
        folderPath(branch.folders, folderId).map(f => f.name),
        name,
    );

function moveFile(files: Record<string, string>, from: string, to: string) {
    const text = files[from]!;
    delete files[from];
    files[to] = text;
    return files;
}

export async function saveDraftOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { id, revision, flow, triggers }: { id: string; revision: number; flow: FlowFile; triggers?: RepoTriggers },
): Promise<UseCaseResult<{ revision: number }>> {
    await refuseReadOnly(ctx, branch);
    const found = branchFlow(branch, id);
    if (!found) {
        return notFound();
    }
    const content = repoFlowToYaml({ ...flow, id, name: found.name }, { deployed: found.deployed, ...(triggers ?? found.triggers) });
    const saved = await saveBranchFile(ctx, branch, { path: found.path, content, fileId: id, expected: revision });
    return saved === null ? changedElsewhere('flow') : success({ revision: saved });
}

export async function createFlowOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { projectId, folderId, name: wanted }: { projectId: string; folderId: string | null; name: string },
): Promise<UseCaseResult<{ id: string }>> {
    await refuseReadOnly(ctx, branch);
    const on = projectOn(branch, projectId);
    if (!on) {
        return fail('not-found', 'Project not found.');
    }
    if (!isFolderVisible(on.tree.folders, folderId)) {
        return fail('not-found', 'Folder not found.');
    }
    const id = crypto.randomUUID();
    const named = await nameInTree(ctx, projectId, on.tree, { kind: 'flow', id, parentId: folderId, name: wanted }, undefined, on.names);
    if (!named.ok) {
        return named;
    }
    await changeBranch(ctx, branch, files => ({
        ...files,
        [flowPath(branch, on.project.name, folderId, named.value)]: repoFlowToYaml(newFlowFile(named.value, id)),
    }));
    return success({ id });
}

async function placeFlow(
    ctx: UseCaseContext,
    branch: WorkBranch,
    flow: BranchFlow | undefined,
    place: { folderId: string | null; name: string },
): Promise<UseCaseResult<FlowView>> {
    await refuseReadOnly(ctx, branch);
    const on = flow && projectOn(branch, flow.projectId);
    if (!flow || !on) {
        return notFound();
    }
    if (!isFolderVisible(on.tree.folders, place.folderId)) {
        return fail('not-found', 'Destination folder not found.');
    }
    const named = await nameInTree(
        ctx,
        flow.projectId,
        on.tree,
        { kind: 'flow', id: flow.id, parentId: place.folderId, name: place.name },
        undefined,
        on.names,
    );
    if (!named.ok) {
        return named;
    }
    const to = flowPath(branch, on.project.name, place.folderId, named.value);
    if (to !== flow.path) {
        await changeBranch(ctx, branch, files => moveFile(files, flow.path, to));
    }
    return success(toFlowView({ ...flow, folderId: place.folderId, name: named.value, updatedAt: new Date(), updatedBy: ctx.userId }));
}

export const renameFlowOnBranch = (ctx: UseCaseContext, branch: WorkBranch, { id, name }: { id: string; name: string }) => {
    const flow = branchFlow(branch, id);
    return placeFlow(ctx, branch, flow, { folderId: flow?.folderId ?? null, name });
};

export const moveFlowOnBranch = (ctx: UseCaseContext, branch: WorkBranch, { id, folderId }: { id: string; folderId: string | null }) => {
    const flow = branchFlow(branch, id);
    return placeFlow(ctx, branch, flow, { folderId, name: flow?.name ?? '' });
};

export async function archiveFlowOnBranch(ctx: UseCaseContext, branch: WorkBranch, id: string): Promise<UseCaseResult<{ id: string }>> {
    await refuseReadOnly(ctx, branch);
    const flow = branchFlow(branch, id);
    if (!flow) {
        return notFound();
    }
    await changeBranch(ctx, branch, files => {
        delete files[flow.path];
        return files;
    });
    return success({ id });
}

export async function createFolderOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { projectId, parentId, name: wanted }: { projectId: string; parentId: string | null; name: string },
): Promise<UseCaseResult<{ id: string }>> {
    await refuseReadOnly(ctx, branch);
    const on = projectOn(branch, projectId);
    if (!on) {
        return fail('not-found', 'Project not found.');
    }
    if (!isFolderVisible(on.tree.folders, parentId)) {
        return fail('not-found', 'Folder not found.');
    }
    const parents = folderPath(branch.folders, parentId).map(f => f.name);
    const named = await nameInTree(
        ctx,
        projectId,
        on.tree,
        { kind: 'folder', id: crypto.randomUUID(), parentId, name: wanted },
        undefined,
        on.names,
    );
    if (!named.ok) {
        return named;
    }
    await changeBranch(ctx, branch, files => ({
        ...files,
        [repoPath.folder(branch.handle, on.project.name, [...parents, named.value])]: '',
    }));
    return success({ id: branchFolderId(projectId, [...parents, named.value]) });
}

export async function saveScriptOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { projectId, path, content, revision }: { projectId: string; path: string; content: string; revision: number },
): Promise<UseCaseResult<{ revision: number }>> {
    await refuseReadOnly(ctx, branch);
    const on = projectOn(branch, projectId);
    if (!on) {
        return fail('not-found', 'Project not found.');
    }
    if (!on.listing.scripts.some(s => s.path === path)) {
        return fail('not-found', 'Script not found.');
    }
    const saved = await saveBranchFile(ctx, branch, {
        path: repoPath.script(branch.handle, on.project.name, path),
        content,
        fileId: scriptFileId(projectId, path),
        expected: revision,
    });
    return saved === null ? changedElsewhere('script') : success({ revision: saved });
}

export async function createScriptOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { projectId, path, kind, content }: { projectId: string; path: string; kind: 'script' | 'folder'; content: string },
): Promise<UseCaseResult<{ path: string; revision: number }>> {
    await refuseReadOnly(ctx, branch);
    const on = projectOn(branch, projectId);
    if (!on) {
        return fail('not-found', 'Project not found.');
    }
    const issue = pathIssueIn(on.listing, path);
    if (issue) {
        return issue.includes('already exists')
            ? fail('conflict', issue, { path: issue })
            : fail('validation', 'The request has invalid fields.', { path: issue });
    }
    const file =
        kind === 'folder'
            ? repoPath.scriptFolder(branch.handle, on.project.name, path)
            : repoPath.script(branch.handle, on.project.name, path);
    await changeBranch(ctx, branch, files => ({ ...files, [file]: kind === 'folder' ? '' : content }));
    return success({ path, revision: 0 });
}

export async function deleteScriptOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { projectId, path }: { projectId: string; path: string },
): Promise<UseCaseResult<{ path: string }>> {
    await refuseReadOnly(ctx, branch);
    const on = projectOn(branch, projectId);
    if (!on) {
        return fail('not-found', 'Project not found.');
    }
    const scripts = on.listing.scripts.filter(s => insideScriptFolder(s.path, path)).map(s => s.path);
    const folders = allFolders(on.listing.scripts, on.listing.folders).filter(f => insideScriptFolder(f, path));
    await changeBranch(ctx, branch, files => {
        for (const script of scripts) {
            delete files[repoPath.script(branch.handle, on.project.name, script)];
        }
        for (const folder of folders) {
            delete files[repoPath.scriptFolder(branch.handle, on.project.name, folder)];
        }
        return files;
    });
    return success({ path });
}

export async function moveScriptOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { projectId, from, to }: { projectId: string; from: string; to: string },
): Promise<UseCaseResult<{ path: string }>> {
    await refuseReadOnly(ctx, branch);
    const on = projectOn(branch, projectId);
    if (!on) {
        return fail('not-found', 'Project not found.');
    }
    if (from === to) {
        return success({ path: to });
    }
    const issue = pathIssueIn(on.listing, to, from);
    if (issue) {
        return issue.includes('already exists')
            ? fail('conflict', issue, { path: issue })
            : fail('validation', 'The request has invalid fields.', { path: issue });
    }
    const moved = (path: string) => movedScriptPath(path, from, to);
    const scripts = on.listing.scripts.map(s => s.path);
    const tooLong = await pathTooLong(
        ctx,
        projectId,
        { tree: on.tree, project: on.project.name, scripts: { scripts: scripts.map(moved), folders: on.listing.folders.map(moved) } },
        'path',
    );
    if (tooLong) {
        return tooLong;
    }

    const script = (path: string) => repoPath.script(branch.handle, on.project.name, path);
    const folder = (path: string) => repoPath.scriptFolder(branch.handle, on.project.name, path);
    await changeBranch(ctx, branch, files => {
        for (const path of scripts.filter(s => insideScriptFolder(s, from))) {
            moveFile(files, script(path), script(moved(path)));
        }
        for (const path of on.listing.folders.filter(f => insideScriptFolder(f, from))) {
            moveFile(files, folder(path), folder(moved(path)));
        }
        const prefix = scriptImportPrefix(branch.handle, handleOf(on.project.name));
        for (const project of branch.projects.filter(p => p.deletedAt === null)) {
            const own = project.id === projectId;
            for (const { path } of branch.scripts.get(project.id) ?? []) {
                const file = repoPath.script(branch.handle, project.name, own ? moved(path) : path);
                files[file] = movedScriptImports(files[file]!, prefix + from, prefix + to);
            }
        }
        for (const flow of branch.flows) {
            const rewritten = flowWithScriptsMoved(flow.file, prefix + from, prefix + to);
            if (rewritten) {
                files[flow.path] = repoFlowToYaml(
                    { ...rewritten, id: flow.id, name: flow.name },
                    { deployed: flow.deployed, ...flow.triggers },
                );
            }
        }
        return files;
    });
    return success({ path: to });
}

export const withNewTriggerIds = ({ schedules, webhooks }: RepoTriggers): RepoTriggers => ({
    schedules: schedules.map(s => ({ ...s, id: crypto.randomUUID() })),
    webhooks: webhooks.map(w => ({ ...w, id: crypto.randomUUID() })),
});

export async function cloneFlowOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { id, name, folderId: wanted }: { id: string; name: string; folderId?: string | null | undefined },
): Promise<UseCaseResult<{ id: string }>> {
    await refuseReadOnly(ctx, branch);
    const source = branchFlow(branch, id);
    const on = source && projectOn(branch, source.projectId);
    if (!source || !on) {
        return notFound();
    }
    const folderId = wanted === undefined ? source.folderId : wanted;
    if (!isFolderVisible(on.tree.folders, folderId)) {
        return fail('not-found', 'Folder not found.');
    }
    const copy = crypto.randomUUID();
    const named = await nameInTree(
        ctx,
        source.projectId,
        on.tree,
        { kind: 'flow', id: copy, parentId: folderId, name },
        undefined,
        on.names,
    );
    if (!named.ok) {
        return named;
    }
    await changeBranch(ctx, branch, files => ({
        ...files,
        [flowPath(branch, on.project.name, folderId, named.value)]: repoFlowToYaml(
            { ...source.file, id: copy, name: named.value },
            withNewTriggerIds(source.triggers),
        ),
    }));
    return success({ id: copy });
}

const projectArchived = () => fail('conflict', 'The project is archived: restore the project first.');

const sameTime = (a: Date, b: Date) => new Date(a).getTime() === b.getTime();

export async function restoreFlowOnBranch(ctx: UseCaseContext, branch: WorkBranch, id: string): Promise<UseCaseResult<FlowView>> {
    await refuseReadOnly(ctx, branch);
    const flow = (await branchArchive(ctx, branch)).flows.find(f => f.id === id);
    if (!flow) {
        return fail('not-found', 'Archived flow not found.');
    }
    const on = projectOn(branch, flow.projectId);
    if (!on) {
        return projectArchived();
    }
    const folderId = flow.folderId !== null && isFolderVisible(on.tree.folders, flow.folderId) ? flow.folderId : null;
    const named = await nameInTree(
        ctx,
        flow.projectId,
        on.tree,
        { kind: 'flow', id, parentId: folderId, name: flow.name },
        undefined,
        on.names,
    );
    if (!named.ok) {
        return named;
    }
    await changeBranch(ctx, branch, files => ({ ...files, [flowPath(branch, on.project.name, folderId, named.value)]: flow.content }));
    return success(toFlowView({ ...flow, folderId, name: named.value, deletedAt: null, updatedAt: new Date(), updatedBy: ctx.userId }));
}

const flowsDir = (branch: WorkBranch, project: string, names: string[]) =>
    `${branch.handle}/projects/${project}/flows/${names.map(name => `${name}/`).join('')}`;

const projectDir = (branch: WorkBranch, project: string) => `${branch.handle}/projects/${project}/`;

function moveDir(files: RepoFiles, from: string, to: string): RepoFiles {
    for (const path of Object.keys(files).filter(path => path.startsWith(from))) {
        moveFile(files, path, `${to}${path.slice(from.length)}`);
    }
    return files;
}

function dropDir(files: RepoFiles, dir: string): RepoFiles {
    for (const path of Object.keys(files).filter(path => path.startsWith(dir))) {
        delete files[path];
    }
    return files;
}

function folderOn(branch: WorkBranch, id: string) {
    const folder = branch.folders.find(f => f.id === id);
    const on = folder && projectOn(branch, folder.projectId);
    return folder && on ? { folder, on, names: folderPath(branch.folders, id).map(f => f.name) } : null;
}

async function placeFolder(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { folder, on, names }: NonNullable<ReturnType<typeof folderOn>>,
    parentId: string | null,
    name: string,
): Promise<UseCaseResult<FolderView>> {
    const placed = [...folderPath(branch.folders, parentId).map(f => f.name), name];
    const from = flowsDir(branch, on.project.name, names);
    const to = flowsDir(branch, on.project.name, placed);
    if (from !== to) {
        await changeBranch(ctx, branch, files => moveDir(files, from, to), { gone: [from] });
    }
    return success(toFolderView({ ...folder, id: branchFolderId(folder.projectId, placed), parentId, name }));
}

export async function renameFolderOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { id, name }: { id: string; name: string },
): Promise<UseCaseResult<FolderView>> {
    await refuseReadOnly(ctx, branch);
    const found = folderOn(branch, id);
    if (!found) {
        return fail('not-found', 'Folder not found.');
    }
    const { folder, on } = found;
    const item = { kind: 'folder' as const, id, parentId: folder.parentId, name };
    const named = await nameInTree(ctx, folder.projectId, on.tree, item, undefined, on.names);
    return named.ok ? placeFolder(ctx, branch, found, folder.parentId, named.value) : named;
}

export async function moveFolderOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { id, parentId }: { id: string; parentId: string | null },
): Promise<UseCaseResult<FolderView>> {
    await refuseReadOnly(ctx, branch);
    const found = folderOn(branch, id);
    if (!found) {
        return fail('not-found', 'Folder not found.');
    }
    const { folder, on } = found;
    if (parentId !== null && !isFolderVisible(on.tree.folders, parentId)) {
        return fail('not-found', 'Destination folder not found.');
    }
    if (!canMoveFolder(on.tree.folders, id, parentId)) {
        return fail('validation', 'A folder cannot move into itself or into a folder under it.', { parentId: 'Invalid' });
    }
    const named = await nameInTree(
        ctx,
        folder.projectId,
        on.tree,
        { kind: 'folder', id, parentId, name: folder.name },
        undefined,
        on.names,
    );
    return named.ok ? placeFolder(ctx, branch, found, parentId, named.value) : named;
}

export async function archiveFolderOnBranch(ctx: UseCaseContext, branch: WorkBranch, id: string): Promise<UseCaseResult<{ id: string }>> {
    await refuseReadOnly(ctx, branch);
    const found = folderOn(branch, id);
    if (!found) {
        return fail('not-found', 'Folder not found.');
    }
    const dir = flowsDir(branch, found.on.project.name, found.names);
    await changeBranch(ctx, branch, files => dropDir(files, dir), { gone: [dir], archives: true });
    return success({ id });
}

export async function restoreFolderOnBranch(ctx: UseCaseContext, branch: WorkBranch, id: string): Promise<UseCaseResult<FolderView>> {
    await refuseReadOnly(ctx, branch);
    const archive = await branchArchive(ctx, branch);
    const folder = archive.folders.find(f => f.id === id);
    if (!folder) {
        return fail('not-found', 'Archived folder not found.');
    }
    const on = projectOn(branch, folder.projectId);
    if (!on) {
        return projectArchived();
    }
    const parents = folder.names.slice(0, -1);
    const parentId = parents.length > 0 ? branchFolderId(folder.projectId, parents) : null;
    const placedParent = parentId !== null && isFolderVisible(on.tree.folders, parentId) ? parentId : null;
    const named = await nameInTree(
        ctx,
        folder.projectId,
        on.tree,
        { kind: 'folder', id, parentId: placedParent, name: folder.name },
        undefined,
        on.names,
    );
    if (!named.ok) {
        return named;
    }
    const placed = [...(placedParent === null ? [] : parents), named.value];
    const from = flowsDir(branch, on.project.name, folder.names);
    const to = flowsDir(branch, on.project.name, placed);
    const live = new Set(branch.flows.map(f => f.id));
    const back = archive.rows.filter(
        r => r.path.startsWith(from) && sameTime(r.updated_at, folder.deletedAt) && !(r.file_id && live.has(r.file_id)),
    );
    await changeBranch(ctx, branch, files => {
        for (const row of back) {
            files[`${to}${row.path.slice(from.length)}`] = row.content!;
        }
        return files;
    });
    return success(
        toFolderView({
            ...folder,
            id: branchFolderId(folder.projectId, placed),
            parentId: placedParent,
            name: named.value,
            deletedAt: null,
        }),
    );
}

// a deleted file's last text is what keeps it in the branch's archive; its deletion stays a change (Discard reads the base)
async function forgetArchived(ctx: UseCaseContext, branch: WorkBranch, paths: string[]): Promise<void> {
    await ctx.db.transaction(async db => {
        await lockBranch(db, ctx.workspaceId, branch.branch);
        await db.query(
            'UPDATE working_copy SET content = NULL WHERE workspace_id = $1 AND branch = $2 AND deleted AND path = ANY($3::text[])',
            [ctx.workspaceId, branch.branch, paths],
        );
    });
}

export async function deleteArchivedFlowOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    id: string,
): Promise<UseCaseResult<{ id: string }>> {
    await refuseReadOnly(ctx, branch);
    if (branchFlow(branch, id)) {
        return fail('conflict', 'Only an archived flow can be deleted: archive it first.');
    }
    const archive = await branchArchive(ctx, branch);
    const flow = archive.flows.find(f => f.id === id);
    if (!flow || !branchProject(branch, flow.projectId)) {
        return fail('not-found', 'Flow not found.');
    }
    await forgetArchived(
        ctx,
        branch,
        archive.rows.filter(r => r.file_id === id).map(r => r.path),
    );
    return success({ id });
}

export async function deleteArchivedFolderOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    id: string,
): Promise<UseCaseResult<{ id: string; flows: number }>> {
    await refuseReadOnly(ctx, branch);
    if (branch.folders.some(f => f.id === id)) {
        return fail('conflict', 'Only an archived folder can be deleted: archive it first.');
    }
    const archive = await branchArchive(ctx, branch);
    const folder = archive.folders.find(f => f.id === id);
    const on = folder && projectOn(branch, folder.projectId);
    if (!folder || !on) {
        return fail('not-found', 'Folder not found.');
    }
    const dir = flowsDir(branch, on.project.name, folder.names);
    const live = new Set(branch.flows.map(f => f.id));
    await forgetArchived(
        ctx,
        branch,
        archive.rows.filter(r => r.path.startsWith(dir) && !(r.file_id && live.has(r.file_id))).map(r => r.path),
    );
    return success({ id, flows: archive.flows.filter(f => f.path.startsWith(dir)).length });
}

// archived: on the branch, and in the environment unless live on the branch
async function branchHandleHolder(ctx: UseCaseContext, branch: WorkBranch, name: string, exceptId?: string) {
    const archived = [
        ...(await branchArchive(ctx, branch)).projects,
        ...(await new ProjectRepository(ctx.db, ctx.workspaceId).findDeleted()),
    ];
    const all = [...branch.projects.map(p => ({ ...p, deletedAt: null })), ...archived];
    return handleHolder(
        name,
        all.filter((p, i) => p.id !== exceptId && all.findIndex(q => q.id === p.id) === i),
    );
}

type ProjectFields = { name: string; description: string; icon: string; color: string };

export async function createProjectOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { name, ...fields }: ProjectFields,
): Promise<UseCaseResult<{ id: string }>> {
    await refuseReadOnly(ctx, branch);
    const holder = await branchHandleHolder(ctx, branch, name);
    if (holder) {
        return handleTaken(name, holder);
    }
    const id = crypto.randomUUID();
    await changeBranch(ctx, branch, files => ({ ...files, [repoPath.project(branch.handle, name)]: projectToYaml({ id, ...fields }) }));
    return success({ id });
}

export async function updateProjectOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { id, ...changes }: { id: string } & Partial<ProjectFields>,
): Promise<UseCaseResult<ProjectView>> {
    await refuseReadOnly(ctx, branch);
    const on = projectOn(branch, id);
    if (!on) {
        return fail('not-found', 'Project not found.');
    }
    const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    const project = { ...on.project, ...defined };
    if (project.name !== on.project.name) {
        const holder = await branchHandleHolder(ctx, branch, project.name, id);
        if (holder) {
            return handleTaken(project.name, holder);
        }
        const tooLong = await pathTooLong(ctx, id, { tree: on.tree, project: project.name, scripts: on.names.scripts });
        if (tooLong) {
            return tooLong;
        }
    }
    const from = projectDir(branch, on.project.name);
    await changeBranch(
        ctx,
        branch,
        files => {
            moveDir(files, from, projectDir(branch, project.name));
            files[repoPath.project(branch.handle, project.name)] = projectToYaml(project);
            return files;
        },
        project.name === on.project.name ? {} : { gone: [from] },
    );
    return success(toProjectView(project));
}

export async function archiveProjectOnBranch(ctx: UseCaseContext, branch: WorkBranch, id: string): Promise<UseCaseResult<{ id: string }>> {
    await refuseReadOnly(ctx, branch);
    const project = branchProject(branch, id);
    if (!project) {
        return fail('not-found', 'Project not found.');
    }
    const dir = projectDir(branch, project.name);
    await changeBranch(ctx, branch, files => dropDir(files, dir), { gone: [dir], archives: true });
    return success({ id });
}

export async function restoreProjectOnBranch(ctx: UseCaseContext, branch: WorkBranch, id: string): Promise<UseCaseResult<ProjectView>> {
    await refuseReadOnly(ctx, branch);
    const archive = await branchArchive(ctx, branch);
    const project = archive.projects.find(p => p.id === id);
    if (!project) {
        return fail('not-found', 'Archived project not found.');
    }
    const holder = await branchHandleHolder(ctx, branch, project.name, id);
    if (holder) {
        return handleTaken(project.name, holder);
    }
    const dir = projectDir(branch, project.name);
    const back = archive.rows.filter(r => r.path.startsWith(dir) && sameTime(r.updated_at, project.deletedAt));
    await changeBranch(ctx, branch, files => {
        for (const row of back) {
            files[row.path] = row.content!;
        }
        return files;
    });
    return success(toProjectView({ ...project, deletedAt: null, deletedBy: null }));
}

export async function branchConnections(ctx: UseCaseContext, branch: WorkBranch): Promise<ConnectionView[]> {
    const rows = await new ConnectionRepository(ctx.db, ctx.workspaceId).findAll();
    return branch.connections.map(({ id, name, type }) => {
        const row = rows.find(r => r.id === id);
        return row && row.type === type
            ? { ...toConnectionView(row), name }
            : { id, name, type, config: {}, server: null, createdAt: branch.at, updatedAt: branch.at, updatedBy: null };
    });
}

type ProfileChange = { name: string; type: string; config: Record<string, string>; newSecrets: { name: string; value: string }[] };

const declaration = (branch: WorkBranch, name: string, id: string, type: string) => ({
    path: repoPath.connection(branch.handle, name),
    text: connectionToYaml({ id, type: type as ConnectionTypeName }),
});

const connectionRow = (db: Database, workspaceId: string, id: string) =>
    new ConnectionRepository(db, workspaceId).findAll(eq(connections.id, id));

// its configuration is kept archived in the environment, so the environment does not declare it until a commit brings it
export async function createConnectionOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { newSecrets, ...fields }: ProfileChange,
): Promise<UseCaseResult<{ id: string }>> {
    await refuseReadOnly(ctx, branch);
    const checked = await checkProfile(ctx, fields, newSecrets, undefined, branch.connections);
    if ('failure' in checked) {
        return checked.failure;
    }
    const id = crypto.randomUUID();
    const file = declaration(branch, checked.value.name, id, checked.value.type);
    await changeBranch(ctx, branch, files => ({ ...files, [file.path]: file.text }), {
        also: async db => {
            for (const secret of usedSecrets(checked.value, newSecrets)) {
                await insertSecret(db, ctx, secret.name, secret.value);
            }
            await new ConnectionRepository(db, ctx.workspaceId).insert({
                id,
                ...checked.value,
                updatedBy: ctx.userId,
                deletedAt: new Date(),
                deletedBy: ctx.userId,
            });
        },
    });
    return success({ id });
}

// the environment's connection keeps its name and type until a commit brings the branch's: its runs would otherwise get a configuration of another type
export async function updateConnectionOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    { id, newSecrets, ...fields }: { id: string } & ProfileChange,
): Promise<UseCaseResult<ConnectionView>> {
    await refuseReadOnly(ctx, branch);
    const declared = branch.connections.find(c => c.id === id);
    if (!declared) {
        return fail('not-found', 'Connection not found.');
    }
    const checked = await checkProfile(ctx, fields, newSecrets, id, branch.connections);
    if ('failure' in checked) {
        return checked.failure;
    }
    const { name, type, config } = checked.value;
    const [row] = await connectionRow(ctx.db, ctx.workspaceId, id);
    if (row && !row.deletedAt && row.type !== type) {
        const environment = (await gitBranch(ctx.db, ctx.workspaceId))?.branch ?? 'the environment';
        return fail(
            'conflict',
            `${environment} has ${row.name} as a ${row.type} connection: change its type on ${environment}, where its configuration is.`,
            { type: `${row.type} on ${environment}` },
        );
    }
    const file = declaration(branch, name, id, type);
    let saved = row;
    await changeBranch(
        ctx,
        branch,
        files => {
            delete files[declared.path];
            files[file.path] = file.text;
            return files;
        },
        {
            also: async db => {
                for (const secret of usedSecrets(checked.value, newSecrets)) {
                    await insertSecret(db, ctx, secret.name, secret.value);
                }
                const updated = { config, updatedAt: new Date(), updatedBy: ctx.userId };
                if (!row) {
                    saved = await new ConnectionRepository(db, ctx.workspaceId).insert({
                        id,
                        ...checked.value,
                        updatedBy: ctx.userId,
                        deletedAt: new Date(),
                        deletedBy: ctx.userId,
                    });
                    return;
                }
                // another type or other fields may reach another server: what the last test found no longer holds
                const moved = row.type !== type || JSON.stringify(row.config) !== JSON.stringify(config);
                [saved] = await db.orm
                    .update(connections)
                    .set({ ...updated, ...(row.deletedAt ? { name, type } : {}), ...(moved ? { server: null } : {}) })
                    .where(and(eq(connections.workspaceId, ctx.workspaceId), eq(connections.id, id)))
                    .returning();
            },
        },
    );
    return success({ ...toConnectionView(saved!), name, type });
}

export async function deleteConnectionOnBranch(
    ctx: UseCaseContext,
    branch: WorkBranch,
    id: string,
): Promise<UseCaseResult<{ id: string }>> {
    await refuseReadOnly(ctx, branch);
    const declared: BranchConnection | undefined = branch.connections.find(c => c.id === id);
    if (!declared) {
        return fail('not-found', 'Connection not found.');
    }
    await changeBranch(ctx, branch, files => {
        delete files[declared.path];
        return files;
    });
    return success({ id });
}
