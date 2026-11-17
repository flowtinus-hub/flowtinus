import { z } from 'zod';
import { mirrorGitChange } from '#features/git/git-mirror';
import { eq } from 'drizzle-orm';
import { isFolderVisible, siblingNames, subtreeIds, validateName } from '@flowtinus/core';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { folders } from '../folder';
import { FlowRepository, FolderRepository, loadTree, nameTaken, pathTooLong, projectArchived, toFolderView, type FolderView } from '../project-tree';

export const RestoreFolderCommand = z.object({ id: z.uuid('Invalid') });

/**
 * Brings an archived folder back with what was archived with it (same time); items archived on their own before stay
 * archived. When the folder it was in is archived or gone, it comes back at the project's root. Refused while its
 * project is archived.
 */
export class RestoreFolderHandler implements UseCaseHandler<FolderView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FolderView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(RestoreFolderCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id } = parsed.value;
        const [folder] = await new FolderRepository(ctx.db, ctx.workspaceId).findAll(eq(folders.id, id));
        if (!folder?.deletedAt) {
            return fail('not-found', 'Archived folder not found.');
        }

        const inArchivedProject = await projectArchived(ctx, folder.projectId);
        if (inArchivedProject) {
            return inArchivedProject;
        }

        const tree = await loadTree(ctx.db, ctx.workspaceId, folder.projectId);
        const parentId = isFolderVisible(tree.folders, folder.parentId) ? folder.parentId : null;
        if (validateName(folder.name, siblingNames(tree, 'folder', parentId, id), 'folder').error === 'Already in use') {
            return nameTaken('folder', folder.name);
        }

        const archivedAt = folder.deletedAt.getTime();
        const together = (item: { deletedAt: Date | null }) => item.deletedAt?.getTime() === archivedAt;
        const subtree = subtreeIds(tree.folders, id);
        const restoredTree = {
            folders: tree.folders.map(f =>
                f.id === id ? { ...f, parentId, archivedAt: null } : subtree.has(f.id) && together(f) ? { ...f, archivedAt: null } : f,
            ),
            flows: tree.flows.map(f => (f.folderId !== null && subtree.has(f.folderId) && together(f) ? { ...f, archivedAt: null } : f)),
        };
        const tooLong = await pathTooLong(ctx, folder.projectId, { tree: restoredTree });
        if (tooLong) {
            return tooLong;
        }
        await mirrorGitChange(ctx, `Restore folder ${folder.name}`, async tx => {
            const folderRepository = new FolderRepository(tx, ctx.workspaceId);
            const flowRepository = new FlowRepository(tx, ctx.workspaceId);
            for (const item of tree.folders.filter(f => subtree.has(f.id) && f.id !== id && together(f))) {
                await folderRepository.restore(item.id);
            }

            for (const item of tree.flows.filter(f => f.folderId !== null && subtree.has(f.folderId) && together(f))) {
                await flowRepository.restore(item.id);
            }

            await folderRepository.restore(id);
            if (parentId !== folder.parentId) {
                await folderRepository.update(id, { parentId });
            }
        });

        const restored = await new FolderRepository(ctx.db, ctx.workspaceId).findById(id);
        return success(toFolderView(restored!));
    }
}
