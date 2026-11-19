import { z } from 'zod';
import { changeTree } from '#features/git/git-first';
import { undeployArchived } from '#features/deployments/deployments';
import { FlowRepository } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';

export const ArchiveFlowCommand = z.object({ id: z.uuid('Invalid') });

/**
 * Archives an active flow (soft delete: the row stays, so its versions and history keep pointing at it). Deployed, it
 * is undeployed with it: its triggers stop and the Flow Invokers calling it fail.
 */
export class ArchiveFlowHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(ArchiveFlowCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id } = parsed.value;
        const archived = await changeTree(ctx, async tx => {
            if (!(await new FlowRepository(tx, ctx.workspaceId).softDelete(id, ctx.userId))) {
                return false;
            }

            await undeployArchived(tx, ctx, [id]);
            return true;
        });
        if (!archived) {
            return fail('not-found', 'Flow not found.');
        }

        return success({ id });
    }
}
