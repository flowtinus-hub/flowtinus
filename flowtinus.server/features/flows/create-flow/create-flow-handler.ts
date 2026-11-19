import { z } from 'zod';
import { isFolderVisible } from '@flowtinus/core';
import { changeTree } from '#features/git/git-first';
import { FlowRepository, loadTree, location, nameInTree, requireActiveProject } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';

export const CreateFlowCommand = z.object({
    projectId: z.uuid('Invalid'),
    folderId: location,
    name: z.string(),
});

export class CreateFlowHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(CreateFlowCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { projectId, folderId } = parsed.value;
        const missing = await requireActiveProject(ctx, projectId);
        if (missing) {
            return missing;
        }

        const tree = await loadTree(ctx.db, ctx.workspaceId, projectId);
        if (!isFolderVisible(tree.folders, folderId)) {
            return fail('not-found', 'Folder not found.');
        }

        const id = crypto.randomUUID();
        const named = await nameInTree(ctx, projectId, tree, { kind: 'flow', id, parentId: folderId, name: parsed.value.name });
        if (!named.ok) {
            return named;
        }

        const name = named.value;
        const flow = await changeTree(ctx, db =>
            new FlowRepository(db, ctx.workspaceId).insert({ id, projectId, folderId, name, updatedBy: ctx.userId }),
        );
        return success({ id: flow.id });
    }
}
