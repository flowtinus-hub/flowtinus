import { z } from 'zod';
import { cronError, DEFAULT_MISFIRE, MISFIRE_MODES } from '@flowtinus/core';
import type { ScheduleFields } from './schedules';

const fileFields = {
    cron: z.string().trim().min(1, 'Required').max(200),
    timezone: z.string().trim().min(1, 'Required').max(100),
    misfire: z.enum(MISFIRE_MODES).default(DEFAULT_MISFIRE),
    parameters: z.record(z.string(), z.string()).default({}),
    input: z.unknown().optional(),
};

const validCron = (value: { cron: string; timezone: string }, issues: z.RefinementCtx) => {
    const error = cronError(value.cron, value.timezone);
    if (error) {
        issues.addIssue({ code: 'custom', path: [/time zone/i.test(error) ? 'timezone' : 'cron'], message: error });
    }
};

export const ScheduleFieldsInput = z.object({ ...fileFields, enabled: z.boolean().default(true) }).superRefine(validCron);

export const FileScheduleInput = z.object(fileFields).superRefine(validCron);

export type ScheduleFieldsValue = z.infer<typeof ScheduleFieldsInput> & ScheduleFields;
