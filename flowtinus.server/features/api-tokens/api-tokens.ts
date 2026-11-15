import { timingSafeEqual } from 'node:crypto';
import type { Database } from '#shared/database/database';
import { fail, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { readRunScope, RunScopeInput, type RunScope } from './run-scope';

/*
 * Personal access tokens (api_tokens): what an agent sends to the MCP (/mcp) as Authorization:
 * Bearer. `ftn_` + 32 random bytes in base64url; only the sha256 is kept, and the first 12 characters (`prefix`) to tell
 * it apart. Each token has scopes; runs:execute (Run for real) and flows:archive are their own; none lets anyone deploy, promote, or read a secret's value or a connection's fields:
 * not even the dev one can. A token's runs:execute may be held to some folders or flows (its run scope, run-scope.ts).
 */

export const API_SCOPES = [
    'catalog:read',
    'flows:read',
    'flows:write',
    /** archive flows (archive_flow): it undeploys them. Only a token its owner gave it to; never implied by flows:write */
    'flows:archive',
    'projects:write',
    'runs:test',
    /** Run for real (run_for_real): writes outside the flow. Only a token its owner gave it to; never implied by runs:test */
    'runs:execute',
    'runs:read',
    'resources:read',
    'resources:write',
    'workspaces:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_INFO: Record<ApiScope, string> = {
    'catalog:read': 'Read the components, the connection types and the flow format; validate a flow.',
    'flows:read': 'Read projects, folders, flows (their drafts), the calls between flows, scripts and deployments.',
    'flows:write': "Create, rename and move flows; save their drafts and scripts; pin and unpin a component's output.",
    'flows:archive': "Archive a flow (it is undeployed), each time with the user's approval.",
    'projects:write': 'Create projects and folders.',
    'runs:test': 'Start and stop test runs (nothing is written outside the flow).',
    'runs:execute':
        "Run flows for real (databases are written, requests are sent): each run with the user's approval, or only the folders and flows of its run scope.",
    'runs:read': "Read runs: their summaries, a component's envelopes, the list of runs.",
    'resources:read': "The names of the workspace's connections, variables and secrets (never a value); test a connection.",
    'resources:write': "Create the workspace's variables or change their values (never a secret).",
    'workspaces:write': 'Create workspaces (only for an admin of the environment).',
};

export type ApiTokenOwner = { tokenId: string; userId: string; scopes: ApiScope[]; runScope: RunScope | null };

export const PAT_PREFIX = 'ftn_';

export const hashApiToken = (token: string) => new Bun.CryptoHasher('sha256').update(token).digest('hex');

export function newApiToken(): { token: string; hash: string; prefix: string } {
    const token = `${PAT_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
    return { token, hash: hashApiToken(token), prefix: token.slice(0, 12) };
}

export const TOUCH_EVERY_MS = 60_000;

type Row = {
    id: string;
    user_id: string;
    token_hash: string;
    scopes: string[];
    expires_at: Date | null;
    revoked_at: Date | null;
    last_used_at: Date | null;
    run_scope: unknown;
};

export async function findApiToken(db: Database, token: string, now = new Date()): Promise<ApiTokenOwner | null> {
    if (!token.startsWith(PAT_PREFIX) || token.length > 200) {
        return null;
    }

    const hash = hashApiToken(token);
    const [row] = await db.query<Row>(
        'SELECT id, user_id, token_hash, scopes, expires_at, revoked_at, last_used_at, run_scope FROM api_tokens WHERE token_hash = $1',
        [hash],
    );
    // the hash found by the index, compared again in constant time
    if (!row || !timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(hash, 'hex'))) {
        return null;
    }
    if (row.revoked_at || (row.expires_at && new Date(row.expires_at) <= now)) {
        return null;
    }

    if (!row.last_used_at || now.getTime() - new Date(row.last_used_at).getTime() >= TOUCH_EVERY_MS) {
        await db.query('UPDATE api_tokens SET last_used_at = $2 WHERE id = $1', [row.id, now]);
    }

    return {
        tokenId: row.id,
        userId: row.user_id,
        scopes: row.scopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)),
        runScope: readRunScope(row.run_scope),
    };
}

export function requireScope(scopes: readonly ApiScope[], scope: ApiScope): UseCaseResult<never> | null {
    return scopes.includes(scope) ? null : fail('forbidden', `This token does not have the scope ${scope}.`);
}

export async function insertApiToken(
    db: Database,
    values: {
        id?: string;
        userId: string;
        name: string;
        token: string;
        scopes: readonly ApiScope[];
        expiresAt?: Date | null;
        runScope?: RunScope | null;
    },
): Promise<string> {
    const id = values.id ?? crypto.randomUUID();
    const runScope = values.runScope ? RunScopeInput.parse(values.runScope) : null;
    await db.query(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes, expires_at, run_scope)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb)
     ON CONFLICT (id) DO UPDATE SET token_hash = EXCLUDED.token_hash, prefix = EXCLUDED.prefix, scopes = EXCLUDED.scopes,
       name = EXCLUDED.name, expires_at = EXCLUDED.expires_at, run_scope = EXCLUDED.run_scope, revoked_at = NULL`,
        [
            id,
            values.userId,
            values.name,
            hashApiToken(values.token),
            values.token.slice(0, 12),
            [...values.scopes],
            values.expiresAt ?? null,
            runScope ? JSON.stringify(runScope) : null,
        ],
    );
    return id;
}
