import { api, type ApiResult } from '@/lib/api';
import type { Webhook, WebhookFields } from './webhook';

/*
 * A flow's webhooks on flowtinus.server (flow_webhooks): the list, a new one (only a deployed flow; its token answered
 * once), one changed, a new token (answered once), one removed. Dates come as ISO text and become Date here.
 */

type WebhookDto = Omit<Webhook, 'last' | 'createdAt' | 'updatedBy'> & {
    last: (Omit<NonNullable<Webhook['last']>, 'at'> & { at: string }) | null;
    createdAt: string;
    updatedBy: string | null;
};

export const toWebhook = (dto: WebhookDto): Webhook => ({
    ...dto,
    updatedBy: dto.updatedBy ?? '',
    last: dto.last ? { ...dto.last, at: new Date(dto.last.at) } : null,
    createdAt: new Date(dto.createdAt),
});

/** the server names a field of the webhook `fields.name`: the form's is `name` */
const fieldErrors = <T>(result: ApiResult<T>): ApiResult<T> =>
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

const withToken = async (path: string, body?: unknown): Promise<ApiResult<{ webhook: Webhook; token: string }>> => {
    const result = fieldErrors(await api<{ webhook: WebhookDto; token: string }>(path, { method: 'POST', body }));
    return result.ok ? { ok: true, value: { webhook: toWebhook(result.value.webhook), token: result.value.token } } : result;
};

export async function listWebhooks(flowId: string): Promise<ApiResult<Webhook[]>> {
    const result = await api<{ items: WebhookDto[] }>(`/flows/${flowId}/webhooks`);
    return result.ok ? { ok: true, value: result.value.items.map(toWebhook) } : result;
}

/** a new webhook (refused while the flow is not deployed), with its token: shown once */
export const createWebhook = (flowId: string, fields: WebhookFields) => withToken(`/flows/${flowId}/webhooks`, fields);

export async function updateWebhook(id: string, fields: WebhookFields): Promise<ApiResult<Webhook>> {
    const result = fieldErrors(await api<WebhookDto>(`/webhooks/${id}`, { method: 'PUT', body: fields }));
    return result.ok ? { ok: true, value: toWebhook(result.value) } : result;
}

/** a new token (the old one stops working at once), shown once */
export const regenerateToken = (id: string) => withToken(`/webhooks/${id}/token`);

export function deleteWebhook(id: string): Promise<ApiResult<{ id: string }>> {
    return api<{ id: string }>(`/webhooks/${id}`, { method: 'DELETE' });
}
