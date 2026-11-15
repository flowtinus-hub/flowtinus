import type { DetectedServer } from '@flowtinus/core';
import { api, type ApiResult } from '@/lib/api';
import type { ConnectionProfile, ProfileFields } from './connection-profile';

/*
 * A workspace's connection profiles on flowtinus.server. Creating or saving one sends the secrets typed in its form along
 * (newSecrets): the server writes both in one transaction, so a failure leaves neither.
 */

/** a secret typed in the connection form ("+ New"), created only when the connection is saved */
export type NewSecret = { name: string; value: string };

type ConnectionDto = Omit<ConnectionProfile, 'createdAt' | 'updatedAt' | 'updatedBy'> & {
    createdAt: string;
    updatedAt: string;
    updatedBy: string | null;
};

export const toConnection = (dto: ConnectionDto): ConnectionProfile => ({
    ...dto,
    updatedBy: dto.updatedBy ?? '',
    createdAt: new Date(dto.createdAt),
    updatedAt: new Date(dto.updatedAt),
});

/** the workspace's connection profiles by name */
export async function listConnections(): Promise<ApiResult<ConnectionProfile[]>> {
    const result = await api<{ items: ConnectionDto[] }>(`/connections`);
    return result.ok ? { ok: true, value: result.value.items.map(toConnection) } : result;
}

export function createConnectionWithSecrets(fields: ProfileFields, newSecrets: NewSecret[] = []): Promise<ApiResult<{ id: string }>> {
    return api<{ id: string }>(`/connections`, { method: 'POST', body: { ...fields, newSecrets } });
}

export async function updateConnectionWithSecrets(
    id: string,
    fields: ProfileFields,
    newSecrets: NewSecret[] = [],
): Promise<ApiResult<ConnectionProfile>> {
    const result = await api<ConnectionDto>(`/connections/${id}`, { method: 'PUT', body: { ...fields, newSecrets } });
    return result.ok ? { ok: true, value: toConnection(result.value) } : result;
}

export function deleteConnection(id: string): Promise<ApiResult<{ id: string }>> {
    return api<{ id: string }>(`/connections/${id}`, { method: 'DELETE' });
}

/**
 * the server checks the profile is complete and its secrets exist; MongoDB and SQL Server it also connects to
 * (a failure is { code: 'unavailable', message: the driver's, secrets masked })
 */
/** the same test of the profile as typed in its form (creating or editing): nothing is saved, new secrets included */
export function testConnectionDraft(
    fields: Pick<ProfileFields, 'type' | 'config'>,
    newSecrets: NewSecret[] = [],
): Promise<ApiResult<{ message: string; ms: number }>> {
    return api<{ message: string; ms: number }>(`/connections/test`, {
        method: 'POST',
        body: { type: fields.type, config: fields.config, newSecrets },
    });
}

/** a test's answer: what it reached and how long it took; a database's server (kept with a saved profile) and, when that server is another engine than the type, why */
export type ConnectionTestAnswer = { message: string; ms: number; server?: DetectedServer; warning?: string };

export function testConnection(id: string): Promise<ApiResult<ConnectionTestAnswer>> {
    return api<ConnectionTestAnswer>(`/connections/${id}/test`, { method: 'POST' });
}
