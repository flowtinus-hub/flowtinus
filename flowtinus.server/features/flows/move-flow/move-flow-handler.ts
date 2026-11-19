import { z } from 'zod';
import { changeTree } from '#features/git/git-first';
import { isFolderVisible } from '@flowtinus/core';
import { FlowRepository, loadTree, location, nameInTree, toFlowView, type FlowView } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';

export const MoveFlowCommand = z.object({ id: z.uuid('Invalid'), folderId: location });

export class MoveFlowHandler implements UseCaseHandler<FlowView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(MoveFlowCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id, folderId } = parsed.value;
        const repository = new FlowRepository(ctx.db, ctx.workspaceId);
        const flow = await repository.findById(id);
        const tree = flow ? await loadTree(ctx.db, ctx.workspaceId, flow.projectId) : null;
        if (!flow || !tree || !isFolderVisible(tree.folders, flow.folderId)) {
            return fail('not-found', 'Flow not found.');
        }

        // the folders of this project only: an id from another project is "not found"
        if (!isFolderVisible(tree.folders, folderId)) {
            return fail('not-found', 'Destination folder not found.');
        }

        const named = await nameInTree(ctx, flow.projectId, tree, { kind: 'flow', id, parentId: folderId, name: flow.name });
        if (!named.ok) {
            return named;
        }

        const moved = await changeTree(ctx, db =>
            new FlowRepository(db, ctx.workspaceId).update(id, { folderId, updatedAt: new Date(), updatedBy: ctx.userId }),
        );
        return moved ? success(toFlowView(moved)) : fail('not-found', 'Flow not found.');
    }
}
