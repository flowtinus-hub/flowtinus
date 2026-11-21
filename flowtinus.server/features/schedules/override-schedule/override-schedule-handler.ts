import { z } from 'zod';
import { cronError, nextTime } from '@flowtinus/core';
import { pgJson } from '#shared/database/jsonb';
import { refuseOverrides } from '#features/git/git-config';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { effectiveValues, findSchedule, SCHEDULES_CHANNEL, storedInputOverride, type ScheduleOverrides, type ScheduleView } from '../schedules';

export const OverrideScheduleCommand = z
    .object({
        id: z.uuid('Invalid'),
        cron: z.string().trim().min(1, 'Required').max(200).nullable().optional(),
        timezone: z.string().trim().min(1, 'Required').max(100).nullable().optional(),
        input: z.unknown().optional(),
        noInput: z.literal(true).optional(),
        parameters: z.record(z.string(), z.string().nullable()).optional(),
    })
    .strict()
    .refine(command => !(command.noInput && command.input !== undefined), { message: 'Either an input or no input', path: ['noInput'] });

type InputPatch = Pick<z.infer<typeof OverrideScheduleCommand>, 'input' | 'noInput'>;

function inputOverride(patch: InputPatch, old: ScheduleOverrides): Pick<ScheduleOverrides, 'input' | 'noInput'> {
    if (patch.noInput) {
        return { noInput: true };
    }
    if (patch.input === undefined) {
        return old.noInput ? { noInput: true } : old.input !== undefined ? { input: old.input } : {};
    }
    return patch.input === null ? {} : { input: patch.input };
}

export class OverrideScheduleHandler implements UseCaseHandler<ScheduleView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ScheduleView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const refused = await refuseOverrides(ctx.db, ctx.workspaceId);
        if (refused) {
            return refused;
        }

        const parsed = validate(OverrideScheduleCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id, cron, timezone, parameters } = parsed.value;
        const schedule = await findSchedule(ctx.db, ctx.workspaceId, id);
        if (!schedule) {
            return fail('not-found', 'Schedule not found.');
        }

        const { cron: oldCron, timezone: oldTimezone } = schedule.overrides;
        const newCron = cron === undefined ? oldCron : (cron ?? undefined);
        const newTimezone = timezone === undefined ? oldTimezone : (timezone ?? undefined);
        const overrides: ScheduleOverrides = {
            ...(newCron !== undefined ? { cron: newCron } : {}),
            ...(newTimezone !== undefined ? { timezone: newTimezone } : {}),
            ...inputOverride(parsed.value, schedule.overrides),
            parameters: Object.fromEntries(
                Object.entries({ ...schedule.overrides.parameters, ...parameters }).filter(
                    (entry): entry is [string, string] => entry[1] !== null,
                ),
            ),
        };
        const effective = effectiveValues(schedule, overrides);
        const error = cronError(effective.cron, effective.timezone);
        if (error) {
            return fail('validation', 'The request has invalid fields.', { [/time zone/i.test(error) ? 'timezone' : 'cron']: error });
        }

        await ctx.db.query(
            `UPDATE flow_schedules SET cron_override = $3, timezone_override = $4, input_override = $5::text::jsonb,
         parameter_overrides = $6::text::jsonb, next_fire_at = CASE WHEN enabled THEN $7::timestamptz END, last_error = NULL,
         updated_by = $8, updated_at = now()
       WHERE workspace_id = $1 AND id = $2`,
            [
                ctx.workspaceId,
                id,
                overrides.cron ?? null,
                overrides.timezone ?? null,
                storedInputOverride(overrides),
                pgJson(overrides.parameters),
                nextTime(effective.cron, effective.timezone, new Date()),
                ctx.userId,
            ],
        );
        await ctx.db.notify(SCHEDULES_CHANNEL, schedule.flowId);
        return success((await findSchedule(ctx.db, ctx.workspaceId, id))!);
    }
}
