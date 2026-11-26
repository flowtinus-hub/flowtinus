import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

const OFF: [method: string, path: string, body?: unknown][] = [
    ['PUT', '/git', { repository: 'https://example.com/flows.git', tokenSecret: 'git-token', environment: 'DEV' }],
    ['DELETE', '/git'],
    ['POST', '/git/test', { repository: 'https://example.com/flows.git', tokenSecret: 'git-token', environment: 'DEV' }],
    ['GET', '/git/on'],
    ['POST', '/git/on', { createBranch: true }],
    ['GET', '/git/topology'],
    ['POST', '/git/topology', { confirm: true }],
    ['GET', '/git/environments'],
    ['POST', '/git/reconcile'],
    ['POST', '/git/hook-token'],
    ['GET', '/git/promotions/graph?from=DEV&to=QA'],
    ['GET', '/git/promotions/preflight?from=DEV&to=QA'],
    ['POST', '/git/promotions', { from: 'DEV', to: 'QA' }],
    ['POST', `/git/promotions/${crypto.randomUUID()}/repair`],
    ['GET', `/git/repairs/preflight?id=${crypto.randomUUID()}`],
    ['GET', '/git/backports/preflight?from=PROD&to=DEV'],
    ['POST', '/git/backports', { from: 'PROD', to: 'DEV' }],
    ['POST', '/git/hotfix', { name: 'fix' }],
    ['POST', '/git/commit', { message: 'Work', paths: [] }],
    ['POST', '/git/pull-request', { title: 'Work' }],
    ['GET', `/flows/${crypto.randomUUID()}/versions/${crypto.randomUUID()}/emergency-rollback`],
    ['POST', `/flows/${crypto.randomUUID()}/versions/${crypto.randomUUID()}/emergency-rollback`],
    ['DELETE', `/flows/${crypto.randomUUID()}/emergency-rollback`],
    ['POST', `/flows/${crypto.randomUUID()}/emergency-rollback/match-git`],
];

describe('a local server: LOCAL reported, the git section read-only, and what belongs to a remote off', () => {
    let db: Database;
    let dir: string;
    let local: ReturnType<typeof createApp>;
    let remote: ReturnType<typeof createApp>;
    const workspaceId = crypto.randomUUID();

    const call = (app: ReturnType<typeof createApp>) => async (method: string, path: string, body?: unknown) => {
        const response = await app.request(wsPath(workspaceId, path), {
            method,
            headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as any };
    };

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-local-'));
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId);
        local = createApp(db, 'LOCAL', undefined, undefined, { git: { clonesDir: join(dir, 'clones'), localRepo: join(dir, 'flows') } });
        remote = createApp(db, 'DEV', undefined, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });
    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('LOCAL on /health and the workers page', async () => {
        expect(await (await local.request('/health')).json()).toEqual({ ok: true, environment: 'LOCAL' });
        expect((await call(local)('GET', '/workers')).body.environment).toBe('LOCAL');
    });

    test("the workspace's git section shows the local mode, read-only; elsewhere it does not", async () => {
        expect((await call(local)('GET', '/git')).body).toEqual({ config: null, on: false, local: { repository: join(dir, 'flows') } });
        expect((await call(remote)('GET', '/git')).body).toEqual({ config: null, on: false });
    });

    test.each(OFF)('%s %s is refused with a reason', async (method, path, body) => {
        const answer = await call(local)(method, path, body);
        expect(answer.status).toBe(409);
        expect(answer.body.error.message).toContain('local server');
    });

    test('the same calls on a server that is not local are not refused for it', async () => {
        for (const [method, path, body] of OFF) {
            const answer = await call(remote)(method, path, body);
            expect(answer.body?.error?.message ?? '').not.toContain('local server');
        }
    });

    test('the git webhook is refused', async () => {
        const answer = await local.request(`/git/hook/${workspaceHandleOf(workspaceId)}/any-token`, { method: 'POST' });
        expect(answer.status).toBe(409);
        expect(((await answer.json()) as any).error.message).toContain('local server');
    });
});
