import { z } from 'zod';
import { canMoveFolder, isFolderVisible, siblingNames, validateName } from '@flowtinus/core';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { FolderRepository, loadTree, location, nameTaken, toFolderView, type FolderView } from '../project-tree';

export const MoveFolderCommand = z.object({ id: z.uuid('Invalid'), parentId: location });

export class MoveFolderHandler implements UseCaseHandler<FolderView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FolderView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(MoveFolderCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id, parentId } = parsed.value;
        const repository = new FolderRepository(ctx.db, ctx.workspaceId);
        const folder = await repository.findById(id);
        const tree = folder ? await loadTree(ctx.db, ctx.workspaceId, folder.projectId) : null;
        if (!folder || !tree || !isFolderVisible(tree.folders, id)) {
            return fail('not-found', 'Folder not found.');
        }

        // the folders of this project only: an id from another project is "not found"
        if (parentId !== null && !isFolderVisible(tree.folders, parentId)) {
            return fail('not-found', 'Destination folder not found.');
        }

        if (!canMoveFolder(tree.folders, id, parentId)) {
            return fail('validation', 'A folder cannot move into itself or into a folder under it.', { parentId: 'Invalid' });
        }

        if (validateName(folder.name, siblingNames(tree, 'folder', parentId, id)).error === 'Already in use') {
            return nameTaken('folder', folder.name);
        }

        const moved = await repository.update(id, { parentId });
        return moved ? success(toFolderView(moved)) : fail('not-found', 'Folder not found.');
    }
}
