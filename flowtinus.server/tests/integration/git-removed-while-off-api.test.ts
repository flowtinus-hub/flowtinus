import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

describe('a work branch removed on the remote while git was off', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const call = async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        const config = { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' };
        await call('PUT', '/git', config);
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        const orders = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        await app.gitPoller.poll(id);

        const at = (path: string) => `${workspaceHandleOf(id)}/${path}`;
        const handle = (await call('GET', '/me')).body.handle as string;
        const branch = `users/${handle}/work`;
        const label = async () =>
            ((await call('GET', `/flows/${orders}/draft`)).body.flow.nodes as { type: string; label?: string }[]).find(
                n => n.type === 'start',
            )?.label;
        const relabel = async (text: string) => {
            const draft = (await call('GET', `/flows/${orders}/draft`)).body;
            draft.flow.nodes = draft.flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label: text } : n));
            return call('PUT', `/flows/${orders}/draft`, { revision: draft.revision, flow: draft.flow });
        };
        const off = async () => expect((await call('DELETE', '/git')).status).toBe(200);
        const on = async () => {
            expect((await call('PUT', '/git', config)).status).toBe(200);
            expect((await call('POST', '/git/on', { choice: 'server' })).status).toBe(200);
        };
        const paths = async () => ((await call('GET', '/git/changes')).body.changes as { path: string }[]).map(c => c.path);
        return { id, call, orders, repo, at, handle, branch, label, relabel, off, on, paths };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-removed-off-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('listed as removed with its changes once on, and a branch made from it starts at its last tip', async () => {
        const { id, call, repo, at, handle, branch, label, relabel, off, on, paths } = await workspace();
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        expect((await relabel('Ana on the branch')).status).toBe(200);
        const lastTip = git(repo, 'rev-parse', branch);

        await off();
        git(repo, 'branch', '-D', branch);
        await on();

        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch, editable: false, removed: true });
        const listed = (await call('GET', '/git/branches')).body.branches as {
            name: string;
            removed?: true;
            lostTip?: true;
            changes: number;
        }[];
        expect(listed.find(b => b.name === branch)).toMatchObject({ removed: true, changes: 1, editable: false });
        expect(listed.find(b => b.name === branch)?.lostTip).toBeUndefined();
        const changes = (await call('GET', '/git/changes')).body;
        expect(changes).toMatchObject({ removed: true });
        expect(changes.lostTip).toBeUndefined();
        expect(await paths()).toEqual([at('projects/Sales/flows/Orders.flow.yaml')]);
        expect(await label()).toBe('Ana on the branch');
        expect((await relabel('Saved on a removed branch')).status).toBe(409);
        await app.gitPoller.poll(id);
        expect((await call('GET', '/git/current-branch')).body).toMatchObject({ branch, removed: true });

        const next = `users/${handle}/kept`;
        const created = await call('POST', '/git/branches', { name: next });
        expect(created.status).toBe(201);
        expect(created.body.cutFrom).toBeUndefined();
        expect(git(repo, 'rev-parse', next)).toBe(lastTip);
        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch: next, editable: true });
        expect(await label()).toBe('Ana on the branch');
        expect(await paths()).toEqual([at('projects/Sales/flows/Orders.flow.yaml')]);

        await app.gitPoller.poll(id);
        const after = (await call('GET', '/git/branches')).body.branches as { name: string }[];
        expect(after.some(b => b.name === branch)).toBe(false);
    });

    test("its last tip unknown here (the clone gone too): removed, and a branch made from it starts at the environment's branch", async () => {
        const { id, call, repo, at, handle, branch, label, relabel, off, on, paths } = await workspace();
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        expect((await relabel('Ana on the branch')).status).toBe(200);

        await off();
        git(repo, 'branch', '-D', branch);
        await rm(join(dir, 'clones', id), { recursive: true, force: true });
        await on();

        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch, editable: false, removed: true, lostTip: true });
        const listed = (await call('GET', '/git/branches')).body.branches as { name: string }[];
        expect(listed.find(b => b.name === branch)).toMatchObject({ removed: true, lostTip: true, changes: 1 });
        expect((await call('GET', '/git/changes')).body).toMatchObject({ removed: true, lostTip: true });
        expect(await paths()).toEqual([at('projects/Sales/flows/Orders.flow.yaml')]);
        expect(await label()).toBe('Ana on the branch');
        await app.gitPoller.poll(id);
        expect((await call('GET', '/git/current-branch')).body).toMatchObject({ branch, removed: true, lostTip: true });

        const next = `users/${handle}/kept`;
        const created = await call('POST', '/git/branches', { name: next });
        expect(created.status).toBe(201);
        expect(created.body.cutFrom).toBe('dev');
        expect(git(repo, 'rev-parse', next)).toBe(git(repo, 'rev-parse', 'dev'));
        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch: next, editable: true });
        expect(await label()).toBe('Ana on the branch');
        expect(await paths()).toEqual([at('projects/Sales/flows/Orders.flow.yaml')]);
        expect((await call('POST', '/git/commit', { paths: await paths(), message: 'Kept' })).status).toBe(200);
        expect(git(repo, 'show', `${next}:${at('projects/Sales/flows/Orders.flow.yaml')}`)).toContain('label: Ana on the branch');
    });
});
