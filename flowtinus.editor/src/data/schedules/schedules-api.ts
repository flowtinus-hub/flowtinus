import { api, type ApiResult } from '@/lib/api';
import type { Schedule, ScheduleFields } from './schedule';

/*
 * A flow's schedules on flowtinus.server (flow_schedules): the list, a new one (only a deployed flow), one changed (all
 * its fields), one removed. Dates come as ISO text and become Date here.
 */

export type ScheduleDto = Omit<Schedule, 'nextFireAt' | 'last' | 'createdAt'> & {
    nextFireAt: string | null;
    last: (Omit<NonNullable<Schedule['last']>, 'at'> & { at: string }) | null;
    createdAt: string;
};

export const toSchedule = (dto: ScheduleDto): Schedule => ({
    ...dto,
    updatedBy: dto.updatedBy ?? '',
    nextFireAt: dto.nextFireAt ? new Date(dto.nextFireAt) : null,
    last: dto.last ? { ...dto.last, at: new Date(dto.last.at) } : null,
    createdAt: new Date(dto.createdAt),
});

/** the server names a field of the schedule `fields.cron`: the form's is `cron` */
const fieldErrors = <T>(result: ApiResult<T>): ApiResult<T> => {
    if (result.ok || !result.error.fields) {
        return result;
    }

    const fields = Object.fromEntries(Object.entries(result.error.fields).map(([key, value]) => [key.replace(/^fields\./, ''), value]));
    return { ok: false, error: { ...result.error, fields } };
};

const one = async (path: string, method: string, body?: unknown): Promise<ApiResult<Schedule>> => {
    const result = fieldErrors(await api<ScheduleDto>(path, { method, body }));
    return result.ok ? { ok: true, value: toSchedule(result.value) } : result;
};

/** the flow's schedules, oldest first */
export async function listSchedules(flowId: string): Promise<ApiResult<Schedule[]>> {
    const result = await api<{ items: ScheduleDto[] }>(`/flows/${flowId}/schedules`);
    return result.ok ? { ok: true, value: result.value.items.map(toSchedule) } : result;
}

/** a new schedule (refused while the flow is not deployed) */
export const createSchedule = (flowId: string, fields: ScheduleFields) => one(`/flows/${flowId}/schedules`, 'POST', fields);

/** a schedule changed: all its fields (its next time is computed again from now) */
export const updateSchedule = (id: string, fields: ScheduleFields) => one(`/schedules/${id}`, 'PUT', fields);

export const switchSchedule = (id: string, enabled: boolean) => one(`/schedules/${id}/enabled`, 'PUT', { enabled });

export function deleteSchedule(id: string): Promise<ApiResult<{ id: string }>> {
    return api<{ id: string }>(`/schedules/${id}`, { method: 'DELETE' });
}
