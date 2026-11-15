import { api, type ApiResult } from '@/lib/api';
import type { ApiToken, NewApiToken, ScopeInfo } from './api-token';

/*
 * The user's personal access tokens on flowtinus.server (/tokens: the environment's, not a workspace's). A new token's
 * value comes in the answer, this once.
 */

type TokenDto = Omit<ApiToken, 'createdAt' | 'lastUsedAt' | 'expiresAt'> & {
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
};

const date = (text: string | null) => (text === null ? null : new Date(text));

export const toToken = (dto: TokenDto): ApiToken => ({
    ...dto,
    createdAt: new Date(dto.createdAt),
    lastUsedAt: date(dto.lastUsedAt),
    expiresAt: date(dto.expiresAt),
});

/** the user's tokens not revoked, newest first, and the scopes a token can have */
export async function listTokens(): Promise<ApiResult<{ items: ApiToken[]; scopes: ScopeInfo[] }>> {
    const result = await api<{ items: TokenDto[]; scopes: ScopeInfo[] }>('/tokens');
    return result.ok ? { ok: true, value: { items: result.value.items.map(toToken), scopes: result.value.scopes } } : result;
}

/** a new token: the token and its value (shown once) */
export async function createToken(token: NewApiToken): Promise<ApiResult<ApiToken & { token: string }>> {
    const result = await api<TokenDto & { token: string }>('/tokens', { method: 'POST', body: token });
    return result.ok ? { ok: true, value: { ...toToken(result.value), token: result.value.token } } : result;
}

/** revokes one of the user's tokens: refused at once */
export function revokeToken(id: string): Promise<ApiResult<{ id: string }>> {
    return api<{ id: string }>(`/tokens/${id}/revoke`, { method: 'POST' });
}
