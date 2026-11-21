import { z } from 'zod';
import { nextTime } from '@flowtinus/core';
import { refuseUndeployed } from '#features/deployments/deployments';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { findSchedule, SCHEDULES_CHANNEL, type ScheduleView } from '../schedules';

export const SwitchScheduleCommand = z.object({ id: z.uuid('Invalid'), enabled: z.boolean() });

export class SwitchScheduleHandler implements UseCaseHandler<ScheduleView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ScheduleView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(SwitchScheduleCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id, enabled } = parsed.value;
        const schedule = await findSchedule(ctx.db, ctx.workspaceId, id);
        if (!schedule) {
            return fail('not-found', 'Schedule not found.');
        }
        const undeployed = enabled && (await refuseUndeployed(ctx.db, ctx.workspaceId, schedule.flowId, 'schedule'));
        if (undeployed) {
            return undeployed;
        }

        await ctx.db.query(
            `UPDATE flow_schedules SET enabled = $3, next_fire_at = $4, arrived_disabled = arrived_disabled AND NOT $3, last_error = NULL,
         updated_by = $5, updated_at = now()
       WHERE workspace_id = $1 AND id = $2`,
            [
                ctx.workspaceId,
                id,
                enabled,
                enabled ? nextTime(schedule.effective.cron, schedule.effective.timezone, new Date()) : null,
                ctx.userId,
            ],
        );
        await ctx.db.notify(SCHEDULES_CHANNEL, schedule.flowId);
        return success((await findSchedule(ctx.db, ctx.workspaceId, id))!);
    }
}
