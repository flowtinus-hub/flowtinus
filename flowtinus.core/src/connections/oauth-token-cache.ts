import { oauthToken, tokenStillGood, type OAuthToken, type ResolvedConnection } from './connection-access';
import type { SendHttp } from '#types/send-http.type';

/*\n * OAuth 2.0 access tokens of a process, one per connection, kept only in memory (never in the database or a log).\n * Requests for a token already being fetched wait for that fetch. A worker's runs ask their supervisor instead.\n */

export type OAuthTokenRequest = {
    key: string;
    fingerprint: string;
    connection: ResolvedConnection;
    timeoutMs: number;
    /** the token the API answered 401 to: dropped, a new one asked (unless another request already got it) */
    refused?: string;
};

export type SourcedOAuthToken = OAuthToken & { askedMs?: number };
export type OAuthTokenSource = (request: OAuthTokenRequest) => Promise<SourcedOAuthToken>;

type Entry = {
    /** what the token was asked with: a profile edited or its secret changed asks a new one */
    fingerprint: string;
    token: Promise<OAuthToken>;
    value?: OAuthToken;
};

const entries = new Map<string, Entry>();

export const oauthFingerprint = (connection: ResolvedConnection): string => {
    const { config, secrets } = connection;
    return JSON.stringify([
        config.tokenUrl ?? '',
        config.clientId ?? '',
        config.scopes ?? '',
        config.audience ?? '',
        config.grant ?? '',
        secrets.clientSecret ?? '',
    ]);
};

export function cachedOAuthToken(key: string, fingerprint: string, ask: () => Promise<OAuthToken>, now = Date.now): Promise<OAuthToken> {
    const found = entries.get(key);
    if (found && found.fingerprint === fingerprint && (!found.value || tokenStillGood(found.value, now()))) {
        return found.token;
    }
    const entry: Entry = { fingerprint, token: Promise.resolve(undefined as never) };
    entry.token = ask().then(
        token => {
            entry.value = token;
            return token;
        },
        error => {
            if (entries.get(key) === entry) {
                entries.delete(key);
            }
            throw error;
        },
    );
    entries.set(key, entry);
    return entry.token;
}

export function dropOAuthToken(key: string, accessToken: string): void {
    if (entries.get(key)?.value?.accessToken === accessToken) {
        entries.delete(key);
    }
}

export async function oauthTokenFromMemory(
    request: OAuthTokenRequest,
    http: SendHttp,
    signal: AbortSignal = new AbortController().signal,
): Promise<SourcedOAuthToken> {
    const { key, fingerprint, connection, timeoutMs, refused } = request;
    if (refused) {
        dropOAuthToken(key, refused);
    }
    let askedMs: number | undefined;
    const token = await cachedOAuthToken(key, fingerprint, async () => {
        const t0 = performance.now();
        const got = await oauthToken(connection, async r => http({ ...r, timeoutMs, signal }));
        askedMs = Math.round(performance.now() - t0);
        return got;
    });
    return askedMs === undefined ? token : { ...token, askedMs };
}

export const cachedAccessTokens = (): string[] => [...entries.values()].flatMap(e => (e.value ? [e.value.accessToken] : []));

export function forgetOAuthTokens(): void {
    entries.clear();
}
