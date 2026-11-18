import { z } from 'zod';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { folderPath, projectRepoPaths, repoPathIssue, siblingNames, validateName, withFlow, withFolder, type ProjectScripts, type TreeContents } from '@flowtinus/core';
import { flows, type Flow } from '#features/flows/flow';
import { ProjectRepository } from '#features/projects/project-repository';
import { listScripts } from '#features/scripts/script-store';
import { workspaces } from '#features/workspaces/workspace';
import { WorkspaceRepository } from '#shared/database/repository';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { folders, type Folder } from './folder';

/*
 * A project's folders and flows as one tree. The rules (unique names among siblings, no folder inside itself, what is
 * visible) are @flowtinus/core's folder-tree, the same the editor shows as you type: handlers load the project's tree
 * and apply them in memory (a project holds tens or hundreds of items, not millions).
 */

export class FolderRepository extends WorkspaceRepository<typeof folders> {
    constructor(db: Database, workspaceId: string) {
        super(db, folders, workspaceId);
    }

    async removeArchived(ids: string[], by: string): Promise<string[]> {
        if (ids.length === 0) {
            return [];
        }

        const rows = await this.db.orm
            .update(folders)
            .set({ removedAt: new Date(), removedBy: by })
            .where(
                and(
                    eq(folders.workspaceId, this.workspaceId),
                    inArray(folders.id, ids),
                    isNotNull(folders.deletedAt),
                    isNull(folders.removedAt),
                ),
            )
            .returning({ id: folders.id });
        return rows.map(r => r.id);
    }
}

export class FlowRepository extends WorkspaceRepository<typeof flows> {
    constructor(db: Database, workspaceId: string) {
        super(db, flows, workspaceId);
    }

    async removeArchived(ids: string[], by: string): Promise<string[]> {
        if (ids.length === 0) {
            return [];
        }

        const rows = await this.db.orm
            .update(flows)
            .set({ removedAt: new Date(), removedBy: by })
            .where(
                and(eq(flows.workspaceId, this.workspaceId), inArray(flows.id, ids), isNotNull(flows.deletedAt), isNull(flows.removedAt)),
            )
            .returning({ id: flows.id });
        return rows.map(r => r.id);
    }
}

export type ProjectTree = {
    folders: (Folder & { archivedAt: Date | null })[];
    flows: (Flow & { archivedAt: Date | null })[];
};

const byCreation = <T extends { createdAt: Date; id: string }>(a: T, b: T) =>
    a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

export async function loadTree(db: Database, workspaceId: string, projectId: string): Promise<ProjectTree> {
    const [folderRows, flowRows] = await Promise.all([
        new FolderRepository(db, workspaceId).findAll(eq(folders.projectId, projectId)),
        new FlowRepository(db, workspaceId).findAll(eq(flows.projectId, projectId)),
    ]);

    // the database's own order changes with updates: the calls, the lists, the clones' order would not hold
    return {
        folders: folderRows.sort(byCreation).map(row => ({ ...row, archivedAt: row.deletedAt })),
        flows: flowRows.sort(byCreation).map(row => ({ ...row, archivedAt: row.deletedAt })),
    };
}

export async function requireActiveProject(ctx: UseCaseContext, projectId: string): Promise<UseCaseResult<{ id: string }> | null> {
    const project = await new ProjectRepository(ctx.db, ctx.workspaceId).findById(projectId);
    return project ? null : fail('not-found', 'Project not found.');
}

export async function projectArchived(ctx: UseCaseContext, projectId: string): Promise<UseCaseResult<never> | null> {
    const project = await new ProjectRepository(ctx.db, ctx.workspaceId).findById(projectId);
    return project ? null : fail('conflict', 'The project is archived: restore the project first.');
}

export const location = z.uuid('Invalid').nullable().default(null);

export type FolderView = {
    id: string;
    projectId: string;
    parentId: string | null;
    name: string;
    createdAt: Date;
    archivedAt: Date | null;
};

export type FlowView = {
    id: string;
    projectId: string;
    folderId: string | null;
    name: string;
    workerTag: string;
    createdAt: Date;
    updatedAt: Date;
    updatedBy: string | null;
    archivedAt: Date | null;
};

export const toFolderView = (folder: Folder): FolderView => ({
    id: folder.id,
    projectId: folder.projectId,
    parentId: folder.parentId,
    name: folder.name,
    createdAt: folder.createdAt,
    archivedAt: folder.deletedAt,
});

export const toFlowView = (flow: Flow): FlowView => ({
    id: flow.id,
    projectId: flow.projectId,
    folderId: flow.folderId,
    name: flow.name,
    workerTag: flow.workerTag,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    updatedBy: flow.updatedBy,
    archivedAt: flow.deletedAt,
});

export const nameTaken = (kind: 'folder' | 'flow', name: string) =>
    fail('conflict', `A ${kind} named "${name}" is already there.`, { name: 'Already in use' });

export const invalidName = (error: string) => fail('validation', 'The request has invalid fields.', { name: error });

export async function workspaceSlug(ctx: UseCaseContext, workspaceId = ctx.workspaceId): Promise<string> {
    const [row] = await ctx.db.orm.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    return row?.slug ?? '';
}

export type ProjectChange = { tree?: TreeContents; project?: string; scripts?: ProjectScripts; workspaceId?: string };

export async function longRepoPath(ctx: UseCaseContext, projectId: string, change: ProjectChange): Promise<string | undefined> {
    const project = change.project ?? (await new ProjectRepository(ctx.db, ctx.workspaceId).findById(projectId))?.name ?? '';
    const tree = change.tree ?? (await loadTree(ctx.db, ctx.workspaceId, projectId));
    const scripts =
        change.scripts ??
        (await listScripts(ctx.db, ctx.workspaceId, projectId).then(({ scripts, folders }) => ({
            scripts: scripts.map(s => s.path),
            folders,
        })));
    const workspace = await workspaceSlug(ctx, change.workspaceId);
    return repoPathIssue(projectRepoPaths(workspace, project, tree, scripts));
}

export async function pathTooLong(
    ctx: UseCaseContext,
    projectId: string,
    change: ProjectChange,
    field = 'name',
): Promise<UseCaseResult<never> | null> {
    const issue = await longRepoPath(ctx, projectId, change);
    return issue ? fail('validation', 'The request has invalid fields.', { [field]: issue }) : null;
}

export type TreeItem = { kind: 'folder' | 'flow'; id: string; parentId: string | null; name: string };

export async function nameInTree(
    ctx: UseCaseContext,
    projectId: string,
    tree: TreeContents,
    item: TreeItem,
    after?: TreeContents,
): Promise<UseCaseResult<string>> {
    const { kind, id, parentId } = item;
    const { value: name, error } = validateName(item.name, siblingNames(tree, kind, parentId, id), kind);
    if (error) {
        return error === 'Already in use' ? nameTaken(kind, name) : invalidName(error);
    }

    const placed =
        after ?? (kind === 'folder' ? withFolder(tree, { id, parentId, name }) : withFlow(tree, { id, folderId: parentId, name }));
    return (await pathTooLong(ctx, projectId, { tree: placed })) ?? success(name);
}

export const folderLabel = (tree: TreeContents, folderId: string | null) =>
    folderId
        ? folderPath(tree.folders, folderId)
              .map(f => f.name)
              .join('/')
        : 'the top';
