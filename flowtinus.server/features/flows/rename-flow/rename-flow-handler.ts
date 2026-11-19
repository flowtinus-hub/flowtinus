import { workBranch } from '#features/git/branch-read';
import { renameFlowOnBranch } from '#features/git/branch-edits';
import { z } from 'zod';
import { changeTree } from '#features/git/git-first';
import { isFolderVisible } from '@flowtinus/core';
import { FlowRepository, loadTree, nameInTree, toFlowView, type FlowView } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';

export const RenameFlowCommand = z.object({ id: z.uuid('Invalid'), name: z.string() });

export class RenameFlowHandler implements UseCaseHandler<FlowView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(RenameFlowCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const branch = await workBranch(ctx);
        if (branch) {
            return renameFlowOnBranch(ctx, branch, parsed.value);
        }
        const repository = new FlowRepository(ctx.db, ctx.workspaceId);
        const flow = await repository.findById(parsed.value.id);
        const tree = flow ? await loadTree(ctx.db, ctx.workspaceId, flow.projectId) : null;
        if (!flow || !tree || !isFolderVisible(tree.folders, flow.folderId)) {
            return fail('not-found', 'Flow not found.');
        }

        const named = await nameInTree(ctx, flow.projectId, tree, {
            kind: 'flow',
            id: flow.id,
            parentId: flow.folderId,
            name: parsed.value.name,
        });
        if (!named.ok) {
            return named;
        }

        const name = named.value;
        const renamed = await changeTree(ctx, db =>
            new FlowRepository(db, ctx.workspaceId).update(flow.id, { name, updatedAt: new Date(), updatedBy: ctx.userId }),
        );
        return renamed ? success(toFlowView(renamed)) : fail('not-found', 'Flow not found.');
    }
}
