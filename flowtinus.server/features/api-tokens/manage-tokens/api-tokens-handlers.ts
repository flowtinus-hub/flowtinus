import { z } from 'zod';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { API_SCOPE_INFO, API_SCOPES, insertApiToken, newApiToken, type ApiScope } from '../api-tokens';
import { readRunScope, RunScopeInput, type RunScope } from '../run-scope';

export const MAX_TOKEN_DAYS = 3650;

export const CreateApiTokenCommand = z
    .object({
        name: z.string().trim().min(1, 'Required').max(100, 'At most 100 characters'),
        scopes: z
            .array(z.enum(API_SCOPES))
            .min(1, 'Pick at least one scope')
            .transform(scopes => [...new Set(scopes)]),
        runScope: RunScopeInput.nullish(),
        expiresInDays: z.number().int().min(1).max(MAX_TOKEN_DAYS).nullish(),
    })
    .superRefine((token, ctx) => {
        if (token.runScope && !token.scopes.includes('runs:execute')) {
            ctx.addIssue({ code: 'custom', path: ['runScope'], message: 'A run scope needs the scope runs:execute.' });
        }
    });

export const RevokeApiTokenCommand = z.object({ id: z.uuid('Invalid') });

export type RunScopeItem = {
    id: string;
    path: string;
    project: string | null;
    workspace: string | null;
    /** archived, gone, or of a workspace the user is no longer in: it still counts in the scope, but runs nothing */
    unavailable?: true;
};

export type ApiTokenView = {
    id: string;
    name: string;
    prefix: string;
    scopes: ApiScope[];
    runScope: { folders: RunScopeItem[]; flows: RunScopeItem[] } | null;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string | null;
};

type Row = {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    run_scope: unknown;
    created_at: Date | string;
    last_used_at: Date | string | null;
    expires_at: Date | string | null;
};

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

async function folderPaths(db: Database, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
        return new Map();
    }
    const rows = await db.query<{ id: string; path: string }>(
        `WITH RECURSIVE up AS (
       SELECT f.id AS start, f.parent_id, f.name::text AS path FROM folders f WHERE f.id = ANY($1::uuid[])
       UNION ALL
       SELECT up.start, p.parent_id, p.name || ' / ' || up.path FROM up JOIN folders p ON p.id = up.parent_id
     )
     SELECT start AS id, path FROM up WHERE parent_id IS NULL`,
        [ids],
    );
    return new Map(rows.map(r => [r.id, r.path]));
}

async function scopeItems(db: Database, userId: string, scopes: RunScope[]): Promise<Map<string, RunScopeItem>> {
    const folderIds = [...new Set(scopes.flatMap(s => s.folders))];
    const flowIds = [...new Set(scopes.flatMap(s => s.flows))];
    const member = 'JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id::text = $2';
    const folders = folderIds.length
        ? await db.query<{ id: string; project: string; workspace: string; archived: boolean }>(
              `SELECT f.id, p.name AS project, w.handle AS workspace, (f.deleted_at IS NOT NULL OR f.removed_at IS NOT NULL) AS archived
           FROM folders f JOIN projects p ON p.id = f.project_id JOIN workspaces w ON w.id = f.workspace_id ${member}
          WHERE f.id = ANY($1::uuid[])`,
              [folderIds, userId],
          )
        : [];
    const flows = flowIds.length
        ? await db.query<{ id: string; name: string; folderId: string | null; project: string; workspace: string; archived: boolean }>(
              `SELECT f.id, f.name, f.folder_id AS "folderId", p.name AS project, w.handle AS workspace,
                (f.deleted_at IS NOT NULL OR f.removed_at IS NOT NULL) AS archived
           FROM flows f JOIN projects p ON p.id = f.project_id JOIN workspaces w ON w.id = f.workspace_id ${member}
          WHERE f.id = ANY($1::uuid[])`,
              [flowIds, userId],
          )
        : [];
    const paths = await folderPaths(db, [...folders.map(f => f.id), ...flows.flatMap(f => (f.folderId ? [f.folderId] : []))]);
    const items = new Map<string, RunScopeItem>();
    for (const f of folders) {
        items.set(f.id, {
            id: f.id,
            path: paths.get(f.id) ?? f.id,
            project: f.project,
            workspace: f.workspace,
            ...(f.archived ? { unavailable: true as const } : {}),
        });
    }
    for (const f of flows) {
        const folder = f.folderId ? paths.get(f.folderId) : undefined;
        items.set(f.id, {
            id: f.id,
            path: folder ? `${folder} / ${f.name}` : f.name,
            project: f.project,
            workspace: f.workspace,
            ...(f.archived ? { unavailable: true as const } : {}),
        });
    }
    return items;
}

const scopeView = (scope: RunScope | null, items: Map<string, RunScopeItem>): ApiTokenView['runScope'] => {
    if (!scope) {
        return null;
    }
    const named = (id: string): RunScopeItem => items.get(id) ?? { id, path: id, project: null, workspace: null, unavailable: true };
    return { folders: scope.folders.map(named), flows: scope.flows.map(named) };
};

async function tokenViews(db: Database, userId: string, rows: Row[]): Promise<ApiTokenView[]> {
    const scopes = rows.map(r => readRunScope(r.run_scope));
    const items = await scopeItems(
        db,
        userId,
        scopes.filter((s): s is RunScope => s !== null),
    );
    return rows.map((r, i) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        scopes: r.scopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)),
        runScope: scopeView(scopes[i]!, items),
        createdAt: iso(r.created_at)!,
        lastUsedAt: iso(r.last_used_at),
        expiresAt: iso(r.expires_at),
    }));
}

const COLUMNS = 'id, name, prefix, scopes, run_scope, created_at, last_used_at, expires_at';

export type ApiTokenList = { items: ApiTokenView[]; scopes: { scope: ApiScope; description: string }[] };

export class ListApiTokensHandler implements UseCaseHandler<ApiTokenList> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ApiTokenList>> {
        const rows = await ctx.db.query<Row>(
            `SELECT ${COLUMNS} FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id`,
            [ctx.userId],
        );
        return success({
            items: await tokenViews(ctx.db, ctx.userId, rows),
            scopes: API_SCOPES.map(scope => ({ scope, description: API_SCOPE_INFO[scope] })),
        });
    }
}

export class CreateApiTokenHandler implements UseCaseHandler<ApiTokenView & { token: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ApiTokenView & { token: string }>> {
        const parsed = validate(CreateApiTokenCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { name, scopes, runScope, expiresInDays } = parsed.value;
        if (runScope) {
            const items = await scopeItems(ctx.db, ctx.userId, [runScope]);
            const missing = [...runScope.folders, ...runScope.flows].filter(id => !items.has(id) || items.get(id)!.unavailable);
            if (missing.length) {
                return fail('validation', `Not found in your workspaces (or archived): ${missing.join(', ')}.`, {
                    runScope: 'Some folders or flows were not found in your workspaces.',
                });
            }
        }

        const { token } = newApiToken();
        const id = await insertApiToken(ctx.db, {
            userId: ctx.userId,
            name,
            token,
            scopes,
            runScope: runScope ?? null,
            expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null,
        });
        const [row] = await ctx.db.query<Row>(`SELECT ${COLUMNS} FROM api_tokens WHERE id = $1`, [id]);
        const [view] = await tokenViews(ctx.db, ctx.userId, [row!]);
        return success({ ...view!, token });
    }
}

export class RevokeApiTokenHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const parsed = validate(RevokeApiTokenCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const [row] = await ctx.db.query<{ id: string }>(
            'UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
            [parsed.value.id, ctx.userId],
        );
        return row ? success({ id: row.id }) : fail('not-found', 'Token not found.');
    }
}
