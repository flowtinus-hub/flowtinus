import { z } from 'zod';
import { isFolderVisible } from '@flowtinus/core';
import { FlowRepository, loadTree, toFlowView, type FlowView } from '#features/folders/project-tree';
import { workerTagError } from '#features/supervisors/supervisors';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';

export const SetFlowWorkerTagCommand = z.object({ id: z.uuid('Invalid'), workerTag: z.string() });

export class SetFlowWorkerTagHandler implements UseCaseHandler<FlowView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(SetFlowWorkerTagCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const repository = new FlowRepository(ctx.db, ctx.workspaceId);
        const flow = await repository.findById(parsed.value.id);
        const tree = flow ? await loadTree(ctx.db, ctx.workspaceId, flow.projectId) : null;
        if (!flow || !tree || !isFolderVisible(tree.folders, flow.folderId)) {
            return fail('not-found', 'Flow not found.');
        }

        const workerTag = parsed.value.workerTag.trim();
        const error = workerTagError(workerTag);
        if (error) {
            return fail('validation', 'The request has invalid fields.', { workerTag: error });
        }

        const changed = await repository.update(flow.id, { workerTag, updatedAt: new Date(), updatedBy: ctx.userId });
        return changed ? success(toFlowView(changed)) : fail('not-found', 'Flow not found.');
    }
}
