import { z } from 'zod';
import { refuseTriggerTables } from '#features/git/git-config';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { SCHEDULES_CHANNEL } from '../schedules';

export const DeleteScheduleCommand = z.object({ id: z.uuid('Invalid') });

export class DeleteScheduleHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor') ?? (await refuseTriggerTables(ctx.db, ctx.workspaceId));
        if (denied) {
            return denied;
        }

        const parsed = validate(DeleteScheduleCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const [deleted] = await ctx.db.query<{ flow_id: string }>(
            'DELETE FROM flow_schedules WHERE workspace_id = $1 AND id = $2 RETURNING flow_id',
            [ctx.workspaceId, parsed.value.id],
        );
        if (!deleted) {
            return fail('not-found', 'Schedule not found.');
        }

        await ctx.db.notify(SCHEDULES_CHANNEL, deleted.flow_id);
        return success({ id: parsed.value.id });
    }
}
