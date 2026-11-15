import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { undeployArchived } from '#features/deployments/deployments';
import { FlowRepository, requireActiveProject } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { flows } from '../flow';

export const DeleteFlowCommand = z.object({ id: z.uuid('Invalid') });

/**
 * Deletes an archived flow (only an archived one: archive it first). The row stays, so its versions, deployment history
 * and runs keep pointing at it, but it is gone from every list, the Archived one included, and cannot be restored. A
 * deploy, schedule or webhook still on (archived before archiving turned them off) is turned off.
 */
export class DeleteFlowHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(DeleteFlowCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id } = parsed.value;
        const [flow] = await new FlowRepository(ctx.db, ctx.workspaceId).findAll(eq(flows.id, id));
        if (!flow) {
            return fail('not-found', 'Flow not found.');
        }

        if (!flow.deletedAt) {
            return fail('conflict', 'Only an archived flow can be deleted: archive it first.');
        }

        if (await requireActiveProject(ctx, flow.projectId)) {
            return fail('not-found', 'Project not found.');
        }

        await ctx.db.transaction(async tx => {
            await new FlowRepository(tx, ctx.workspaceId).removeArchived([id], ctx.userId);
            await undeployArchived(tx, ctx, [id]);
        });
        return success({ id });
    }
}
