import { api, type ApiResult } from '@/lib/api';
import type { Variable } from './variable';

/* A workspace's variables on flowtinus.server: plain values, shown and editable. */

type VariableDto = Omit<Variable, 'createdAt' | 'updatedAt' | 'updatedBy'> & {
    createdAt: string;
    updatedAt: string;
    updatedBy: string | null;
};

export const toVariable = (dto: VariableDto): Variable => ({
    ...dto,
    updatedBy: dto.updatedBy ?? '',
    createdAt: new Date(dto.createdAt),
    updatedAt: new Date(dto.updatedAt),
});

/** the workspace's variables by name, with their values */
export async function listVariables(): Promise<ApiResult<Variable[]>> {
    const result = await api<{ items: VariableDto[] }>(`/variables`);
    return result.ok ? { ok: true, value: result.value.items.map(toVariable) } : result;
}

export function createVariable(fields: { name: string; value: string }): Promise<ApiResult<{ id: string }>> {
    return api<{ id: string }>(`/variables`, { method: 'POST', body: fields });
}

/** changes the value (the name stays: flows refer to it) */
export async function updateVariable(id: string, value: string): Promise<ApiResult<Variable>> {
    const result = await api<VariableDto>(`/variables/${id}`, { method: 'PATCH', body: { value } });
    return result.ok ? { ok: true, value: toVariable(result.value) } : result;
}

export function deleteVariable(id: string): Promise<ApiResult<{ id: string }>> {
    return api<{ id: string }>(`/variables/${id}`, { method: 'DELETE' });
}
