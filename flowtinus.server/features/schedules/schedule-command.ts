import { z } from 'zod';
import { cronError, MISFIRE_MODES, type ScheduleFields } from './schedules';

export const ScheduleFieldsInput = z
    .object({
        cron: z.string().trim().min(1, 'Required').max(200),
        timezone: z.string().trim().min(1, 'Required').max(100),
        enabled: z.boolean().default(true),
        misfire: z.enum(MISFIRE_MODES).default('relaxed'),
        parameters: z.record(z.string(), z.string()).default({}),
        input: z.unknown().optional(),
    })
    .superRefine((value, issues) => {
        const error = cronError(value.cron, value.timezone);
        if (error) {
            issues.addIssue({ code: 'custom', path: [/time zone/i.test(error) ? 'timezone' : 'cron'], message: error });
        }
    });

export type ScheduleFieldsValue = z.infer<typeof ScheduleFieldsInput> & ScheduleFields;
