import type { MisfireMode, WebhookResponse } from '@flowtinus/core';
import { api, type ApiResult } from '@/lib/api';
import type { Schedule } from '@/data/schedules/schedule';
import { toSchedule, type ScheduleDto } from '@/data/schedules/schedules-api';
import type { Webhook } from '@/data/webhooks/webhook';
import { toWebhook, type WebhookDto } from '@/data/webhooks/webhooks-api';

export type FileSchedule = {
    id: string;
    cron: string;
    timezone: string;
    misfire: MisfireMode;
    parameters: Record<string, string>;
    input?: unknown;
};

export type FileWebhook = { id: string; name: string; response: WebhookResponse };

export type FileScheduleFields = Omit<FileSchedule, 'id'>;

export type FileWebhookFields = Omit<FileWebhook, 'id'>;

export type FlowTriggers = {
    file: { editable: boolean; offersBranch?: true; readOnly?: string };
    schedules: FileSchedule[];
    webhooks: FileWebhook[];
    environment: { schedules: Schedule[]; webhooks: Webhook[] } | null;
};

type FlowTriggersDto = Omit<FlowTriggers, 'environment'> & { environment: { schedules: ScheduleDto[]; webhooks: WebhookDto[] } | null };

export async function getFlowTriggers(flowId: string): Promise<ApiResult<FlowTriggers>> {
    const result = await api<FlowTriggersDto>(`/flows/${flowId}/triggers`);
    if (!result.ok) {
        return result;
    }
    const { environment } = result.value;
    return {
        ok: true,
        value: {
            ...result.value,
            environment: environment && { schedules: environment.schedules.map(toSchedule), webhooks: environment.webhooks.map(toWebhook) },
        },
    };
}

const withoutPrefix = <T>(result: ApiResult<T>): ApiResult<T> =>
    result.ok || !result.error.fields
        ? result
        : {
              ok: false,
              error: {
                  ...result.error,
                  fields: Object.fromEntries(
                      Object.entries(result.error.fields).map(([key, value]) => [key.replace(/^fields\./, ''), value]),
                  ),
              },
          };

export const saveFileSchedule = async (flowId: string, id: string | null, fields: FileScheduleFields) =>
    withoutPrefix(
        await api<FileSchedule>(`/flows/${flowId}/triggers/schedules${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: fields }),
    );

export const removeFileSchedule = (flowId: string, id: string) =>
    api<{ id: string }>(`/flows/${flowId}/triggers/schedules/${id}`, { method: 'DELETE' });

export const saveFileWebhook = async (flowId: string, id: string | null, fields: FileWebhookFields) =>
    withoutPrefix(
        await api<FileWebhook>(`/flows/${flowId}/triggers/webhooks${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', body: fields }),
    );

export const removeFileWebhook = (flowId: string, id: string) =>
    api<{ id: string }>(`/flows/${flowId}/triggers/webhooks/${id}`, { method: 'DELETE' });

export type OverridesPatch = {
    cron?: string | null;
    timezone?: string | null;
    input?: unknown;
    parameters?: Record<string, string | null>;
};

export async function overrideSchedule(id: string, patch: OverridesPatch): Promise<ApiResult<Schedule>> {
    const result = await api<ScheduleDto>(`/schedules/${id}/overrides`, { method: 'PUT', body: patch });
    return result.ok ? { ok: true, value: toSchedule(result.value) } : result;
}
