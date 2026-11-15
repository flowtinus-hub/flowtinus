import { api, type ApiResult } from '@/lib/api';
import type { Secret } from './secret';

/* A workspace's secrets on flowtinus.server: names only; a value goes in and never comes back. */

type SecretDto = Omit<Secret, 'createdAt' | 'updatedAt' | 'updatedBy'> & { createdAt: string; updatedAt: string; updatedBy: string | null };

export const toSecret = (dto: SecretDto): Secret => ({
    ...dto,
    updatedBy: dto.updatedBy ?? '',
    createdAt: new Date(dto.createdAt),
    updatedAt: new Date(dto.updatedAt),
});

/** the workspace's secrets by name, without their values */
export async function listSecrets(): Promise<ApiResult<Secret[]>> {
    const result = await api<{ items: SecretDto[] }>(`/secrets`);
    return result.ok ? { ok: true, value: result.value.items.map(toSecret) } : result;
}

export function createSecret(fields: { name: string; value: string }): Promise<ApiResult<{ id: string }>> {
    return api<{ id: string }>(`/secrets`, { method: 'POST', body: fields });
}

/** replaces the value (the old one is not shown, nor returned) */
export async function updateSecretValue(id: string, value: string): Promise<ApiResult<Secret>> {
    const result = await api<SecretDto>(`/secrets/${id}/value`, { method: 'PUT', body: { value } });
    return result.ok ? { ok: true, value: toSecret(result.value) } : result;
}

export function deleteSecret(id: string): Promise<ApiResult<{ id: string }>> {
    return api<{ id: string }>(`/secrets/${id}`, { method: 'DELETE' });
}
