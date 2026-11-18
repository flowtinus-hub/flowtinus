import { z } from 'zod';
import { changeTree } from '#features/git/git-first';
import { isFolderVisible } from '@flowtinus/core';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { FolderRepository, loadTree, location, nameInTree, requireActiveProject } from '../project-tree';

export const CreateFolderCommand = z.object({
    projectId: z.uuid('Invalid'),
    parentId: location,
    name: z.string(),
});

export class CreateFolderHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(CreateFolderCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { projectId, parentId } = parsed.value;
        const missing = await requireActiveProject(ctx, projectId);
        if (missing) {
            return missing;
        }

        const tree = await loadTree(ctx.db, ctx.workspaceId, projectId);
        if (!isFolderVisible(tree.folders, parentId)) {
            return fail('not-found', 'Folder not found.');
        }

        const id = crypto.randomUUID();
        const named = await nameInTree(ctx, projectId, tree, { kind: 'folder', id, parentId, name: parsed.value.name });
        if (!named.ok) {
            return named;
        }

        const name = named.value;
        const folder = await changeTree(
            ctx,
            () => `Create folder ${name}`,
            db => new FolderRepository(db, ctx.workspaceId).insert({ id, projectId, parentId, name }),
        );
        return success({ id: folder.id });
    }
}
