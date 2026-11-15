import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ANA, BIA, insertMember, insertUser, insertWorkspace, wsPath } from '../helpers/workspaces';
import { createApp } from '../../api/app';
import { Hono } from 'hono';
import { openDatabase, type Database } from '#shared/database/database';
import { API_SCOPES, findApiToken, insertApiToken, newApiToken, requireScope, TOUCH_EVERY_MS } from '#features/api-tokens/api-tokens';
import { DEV_PAT, DEV_USER, seedDev } from '#shared/database/seed-dev';
import { toHttpResult } from '#shared/use-cases/to-http-result';
import { success } from '#shared/use-cases/use-case-result';
import { bearerAuth } from '../../api/middlewares/bearer-auth';
import type { AppEnv } from '../../api/app-env';

setDefaultTimeout(30_000);

describe('personal access tokens', () => {
    let db: Database;
    const workspaceId = crypto.randomUUID();
    let ana: string;
    // a route behind the token that needs flows:read
    const app = new Hono<AppEnv>();
    const call = async (token: string | null) => {
        const r = await app.request('/x', { headers: token ? { authorization: `Bearer ${token}` } : {} });
        return { status: r.status, body: (await r.json()) as { error?: { code: string; message: string } } & Record<string, unknown> };
    };

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId, 'Org');
        ana = await insertMember(db, workspaceId);
        app.use('*', bearerAuth(db));
        app.get('/x', c => {
            const missing = requireScope(c.get('scopes') ?? [], 'flows:read');
            const { workspaceId: workspace, userId } = c.get('useCase');
            return toHttpResult(c, missing ?? success({ workspace, userId }));
        });
    });
    afterAll(() => db.close());

    test('a new token: ftn_ and 43 base64url characters, kept only as its hash', async () => {
        const { token, hash, prefix } = newApiToken();
        expect(token).toMatch(/^ftn_[A-Za-z0-9_-]{43}$/);
        expect(prefix).toBe(token.slice(0, 12));
        await insertApiToken(db, { userId: ana, name: 'mine', token, scopes: ['flows:read'] });
        const [row] = await db.query<{ token_hash: string; prefix: string }>(
            'SELECT token_hash, prefix FROM api_tokens WHERE prefix = $1',
            [prefix],
        );
        expect(row).toEqual({ token_hash: hash, prefix });
    });

    test('valid: its user (each call names the workspace it acts in)', async () => {
        const { token } = newApiToken();
        await insertApiToken(db, { userId: ana, name: 'valid', token, scopes: ['flows:read'] });
        expect(await call(token)).toEqual({ status: 200, body: { workspace: '', userId: ana } });
    });

    test('missing or unknown: 401 unauthenticated', async () => {
        expect((await call(null)).status).toBe(401);
        const unknown = await call(newApiToken().token);
        expect(unknown.status).toBe(401);
        expect(unknown.body.error?.code).toBe('unauthenticated');
        expect((await call('not-a-pat')).status).toBe(401);
    });

    test('revoked or expired: 401', async () => {
        const revoked = newApiToken().token;
        const id = await insertApiToken(db, { userId: ana, name: 'revoked', token: revoked, scopes: ['flows:read'] });
        await db.query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1', [id]);
        expect((await call(revoked)).status).toBe(401);

        const expired = newApiToken().token;
        await insertApiToken(db, {
            userId: ana,
            name: 'expired',
            token: expired,
            scopes: ['flows:read'],
            expiresAt: new Date(Date.now() - 1000),
        });
        expect((await call(expired)).status).toBe(401);
    });

    test('without the scope: 403 forbidden, naming it', async () => {
        const { token } = newApiToken();
        await insertApiToken(db, { userId: ana, name: 'narrow', token, scopes: ['catalog:read'] });
        const answer = await call(token);
        expect(answer.status).toBe(403);
        expect(answer.body.error).toEqual({ code: 'forbidden', message: 'This token does not have the scope flows:read.' });
    });

    test('last used: written once, then at most every TOUCH_EVERY_MS', async () => {
        const { token } = newApiToken();
        const id = await insertApiToken(db, { userId: ana, name: 'touch', token, scopes: [] });
        const lastUsed = async () =>
            (await db.query<{ last_used_at: Date }>('SELECT last_used_at FROM api_tokens WHERE id = $1', [id]))[0]!.last_used_at;
        const t0 = new Date('2026-11-08T00:00:00Z');
        await findApiToken(db, token, t0);
        expect(new Date(await lastUsed())).toEqual(t0);
        await findApiToken(db, token, new Date(t0.getTime() + TOUCH_EVERY_MS - 1));
        expect(new Date(await lastUsed())).toEqual(t0);
        const later = new Date(t0.getTime() + TOUCH_EVERY_MS);
        await findApiToken(db, token, later);
        expect(new Date(await lastUsed())).toEqual(later);
    });

    test('the dev seed: its token with every scope; SEED_DEV_PAT replaces it', async () => {
        await seedDev(db);
        expect(await findApiToken(db, DEV_PAT)).toMatchObject({ userId: DEV_USER.id, scopes: [...API_SCOPES] });
        await seedDev(db, 'ftn_dev_other');
        expect(await findApiToken(db, DEV_PAT)).toBeNull();
        expect(await findApiToken(db, 'ftn_dev_other')).toMatchObject({ userId: DEV_USER.id });
    });
});

describe('the Access tokens page: /tokens', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    const workspaceId = crypto.randomUUID();
    let folderId: string;
    let subfolderFlow: string;

    const call = async (user: string, method: string, path: string, body?: unknown) => {
        const response = await app.request(wsPath(workspaceId, path), {
            method,
            headers: { 'x-user-id': user, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> & { error?: { code: string } } };
    };

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId, 'acme');
        app = createApp(db, 'DEV');
        const projectId = (await call(ANA, 'POST', '/projects', { name: 'Engage' })).body.id as string;
        folderId = (await call(ANA, 'POST', `/projects/${projectId}/folders`, { name: 'DW' })).body.id as string;
        const sub = (await call(ANA, 'POST', `/projects/${projectId}/folders`, { name: 'Load', parentId: folderId })).body.id as string;
        subfolderFlow = (await call(ANA, 'POST', `/projects/${projectId}/flows`, { name: 'Load Page', folderId: sub })).body.id as string;
    });
    afterAll(() => db.close());

    test('a new token: its value once, its scopes and run scope named; it works on the MCP with that scope', async () => {
        const made = await call(ANA, 'POST', '/tokens', {
            name: 'Agent',
            scopes: ['runs:execute', 'runs:read'],
            runScope: { folders: [folderId], flows: [subfolderFlow] },
            expiresInDays: 30,
        });
        expect(made.status).toBe(201);
        expect(made.body.token).toMatch(/^ftn_/);
        expect(made.body).toMatchObject({
            name: 'Agent',
            scopes: ['runs:execute', 'runs:read'],
            runScope: {
                folders: [{ id: folderId, path: 'DW', project: 'Engage' }],
                flows: [{ id: subfolderFlow, path: 'DW / Load / Load Page', project: 'Engage' }],
            },
            lastUsedAt: null,
        });
        expect(made.body.expiresAt).toBeString();
        const owner = await findApiToken(db, made.body.token as string);
        expect(owner).toMatchObject({ userId: ANA, runScope: { folders: [folderId], flows: [subfolderFlow] } });

        const list = await call(ANA, 'GET', '/tokens');
        const items = list.body.items as Record<string, unknown>[];
        expect(items.find(t => t.id === made.body.id)).not.toHaveProperty('token');
        expect((list.body.scopes as { scope: string }[]).map(s => s.scope)).toEqual([...API_SCOPES]);
    });

    test("only the user's own: another user neither lists nor revokes it; revoked, it no longer works", async () => {
        const made = await call(ANA, 'POST', '/tokens', { name: 'Mine', scopes: ['flows:read'] });
        const id = made.body.id as string;
        expect(((await call(BIA, 'GET', '/tokens')).body.items as { id: string }[]).some(t => t.id === id)).toBe(false);
        expect((await call(BIA, 'POST', `/tokens/${id}/revoke`)).body.error?.code).toBe('not-found');
        expect(await findApiToken(db, made.body.token as string)).not.toBeNull();

        expect((await call(ANA, 'POST', `/tokens/${id}/revoke`)).body).toEqual({ id });
        expect(await findApiToken(db, made.body.token as string)).toBeNull();
        expect(((await call(ANA, 'GET', '/tokens')).body.items as { id: string }[]).some(t => t.id === id)).toBe(false);
        expect((await call(ANA, 'POST', `/tokens/${id}/revoke`)).body.error?.code).toBe('not-found');
    });

    test("a run scope of folders or flows not in the user's workspaces is refused; one without runs:execute too", async () => {
        const stranger = await insertUser(db, 'Out');
        expect(
            (await call(stranger, 'POST', '/tokens', { name: 'X', scopes: ['runs:execute'], runScope: { folders: [folderId] } })).body.error
                ?.code,
        ).toBe('validation');
        expect(
            (await call(ANA, 'POST', '/tokens', { name: 'X', scopes: ['runs:execute'], runScope: { flows: [crypto.randomUUID()] } }))
                .status,
        ).toBe(400);
        expect((await call(ANA, 'POST', '/tokens', { name: 'X', scopes: ['runs:test'], runScope: { folders: [folderId] } })).status).toBe(
            400,
        );
    });
});
