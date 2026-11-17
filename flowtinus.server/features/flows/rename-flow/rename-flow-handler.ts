import { z } from 'zod';
import { mirrorGitChange } from '#features/git/git-mirror';
import { isFolderVisible, siblingNames, validateName, withFlow } from '@flowtinus/core';
import { FlowRepository, invalidName, loadTree, nameTaken, pathTooLong, toFlowView, type FlowView } from '#features/folders/project-tree';
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

        const repository = new FlowRepository(ctx.db, ctx.workspaceId);
        const flow = await repository.findById(parsed.value.id);
        const tree = flow ? await loadTree(ctx.db, ctx.workspaceId, flow.projectId) : null;
        if (!flow || !tree || !isFolderVisible(tree.folders, flow.folderId)) {
            return fail('not-found', 'Flow not found.');
        }

        const { value: name, error } = validateName(parsed.value.name, siblingNames(tree, 'flow', flow.folderId, flow.id), 'flow');
        if (error) {
            return error === 'Already in use' ? nameTaken('flow', name) : invalidName(error);
        }

        const tooLong = await pathTooLong(ctx, flow.projectId, { tree: withFlow(tree, { id: flow.id, folderId: flow.folderId, name }) });
        if (tooLong) {
            return tooLong;
        }

        const renamed = await mirrorGitChange(ctx, `Rename flow ${flow.name} to ${name}`, db =>
            new FlowRepository(db, ctx.workspaceId).update(flow.id, { name, updatedAt: new Date(), updatedBy: ctx.userId }),
        );
        return renamed ? success(toFlowView(renamed)) : fail('not-found', 'Flow not found.');
    }
}
