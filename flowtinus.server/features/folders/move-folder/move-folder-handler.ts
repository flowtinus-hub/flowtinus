import { z } from 'zod';
import { mirrorGitChange } from '#features/git/git-mirror';
import { canMoveFolder, folderPath, isFolderVisible, siblingNames, validateName, withFolder } from '@flowtinus/core';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { FolderRepository, loadTree, location, nameTaken, pathTooLong, toFolderView, type FolderView } from '../project-tree';

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

        if (validateName(folder.name, siblingNames(tree, 'folder', parentId, id), 'folder').error === 'Already in use') {
            return nameTaken('folder', folder.name);
        }

        const tooLong = await pathTooLong(ctx, folder.projectId, { tree: withFolder(tree, { id, parentId, name: folder.name }) });
        if (tooLong) {
            return tooLong;
        }

        const to = parentId
            ? folderPath(tree.folders, parentId)
                  .map(f => f.name)
                  .join('/')
            : 'the top';
        const moved = await mirrorGitChange(ctx, `Move folder ${folder.name} to ${to}`, db =>
            new FolderRepository(db, ctx.workspaceId).update(id, { parentId }),
        );
        return moved ? success(toFolderView(moved)) : fail('not-found', 'Folder not found.');
    }
}
