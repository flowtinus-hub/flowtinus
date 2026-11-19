import { folderPath, insideScriptFolder, isFolderVisible, newFlowFile, repoFlowToYaml, repoPath, type FlowFile } from '@flowtinus/core';
import { nameInTree, toFlowView, type FlowView } from '#features/folders/project-tree';
import { allFolders, pathIssueIn } from '#features/scripts/script-store';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { branchFlow, branchFolderId, branchProject, branchTree, type BranchFlow, type WorkBranch } from './branch-read';
import { changeBranch, refuseReadOnly, saveBranchFile } from './branch-write';
import { scriptFileId } from './working-copy';

/*
 * The handlers' work on a work branch, on its files (branch-write.ts): a draft or a script saved, a flow made, renamed,
 * moved or archived, a folder made, a script made or removed. The other changes of the tree are made on the
 * environment's branch for now (changeTree refuses them here).
 */

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
        branch.slug,
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
    { id, revision, flow }: { id: string; revision: number; flow: FlowFile },
): Promise<UseCaseResult<{ revision: number }>> {
    await refuseReadOnly(ctx, branch);
    const found = branchFlow(branch, id);
    if (!found) {
        return notFound();
    }
    const content = repoFlowToYaml({ ...flow, id, name: found.name }, { deployed: found.deployed });
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
        [repoPath.folder(branch.slug, on.project.name, [...parents, named.value])]: '',
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
        path: repoPath.script(branch.slug, on.project.name, path),
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
        kind === 'folder' ? repoPath.scriptFolder(branch.slug, on.project.name, path) : repoPath.script(branch.slug, on.project.name, path);
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
            delete files[repoPath.script(branch.slug, on.project.name, script)];
        }
        for (const folder of folders) {
            delete files[repoPath.scriptFolder(branch.slug, on.project.name, folder)];
        }
        return files;
    });
    return success({ path });
}
