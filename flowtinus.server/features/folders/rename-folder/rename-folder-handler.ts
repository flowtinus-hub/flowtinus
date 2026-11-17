import { z } from 'zod';
import { isFolderVisible, siblingNames, validateName, withFolder } from '@flowtinus/core';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { FolderRepository, invalidName, loadTree, nameTaken, pathTooLong, toFolderView, type FolderView } from '../project-tree';

export const RenameFolderCommand = z.object({ id: z.uuid('Invalid'), name: z.string() });

export class RenameFolderHandler implements UseCaseHandler<FolderView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FolderView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(RenameFolderCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const repository = new FolderRepository(ctx.db, ctx.workspaceId);
        const folder = await repository.findById(parsed.value.id);
        const tree = folder ? await loadTree(ctx.db, ctx.workspaceId, folder.projectId) : null;
        if (!folder || !tree || !isFolderVisible(tree.folders, folder.id)) {
            return fail('not-found', 'Folder not found.');
        }

        const { value: name, error } = validateName(parsed.value.name, siblingNames(tree, 'folder', folder.parentId, folder.id), 'folder');
        if (error) {
            return error === 'Already in use' ? nameTaken('folder', name) : invalidName(error);
        }

        const tooLong = await pathTooLong(ctx, folder.projectId, {
            tree: withFolder(tree, { id: folder.id, parentId: folder.parentId, name }),
        });
        if (tooLong) {
            return tooLong;
        }

        const renamed = await repository.update(folder.id, { name });
        return renamed ? success(toFolderView(renamed)) : fail('not-found', 'Folder not found.');
    }
}
