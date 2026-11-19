import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newFlowFile, repoFlowToYaml } from '@flowtinus/core';
import { ANA, BIA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Change = { path: string; from?: string; change: string; mine: boolean };

describe('work branches: create one taking the changes along, edit and Commit on it', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const as = (user: string) => async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': user, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const call = as(ANA);
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        const orders = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        await app.gitPoller.poll(id);

        const slug = slugOf(id);
        const at = (path: string) => `${slug}/${path}`;
        const handle = async (user: string) => (await as(user)('GET', '/me')).body.handle as string;
        const show = (ref: string, path: string) => git(repo, 'show', `${ref}:${at(path)}`);
        const changes = async (user: string) =>
            ((await as(user)('GET', '/git/changes')).body.changes as Change[]).map(c => (c.from ? `${c.from} -> ${c.path}` : c.path));
        const relabel = async (user: string, flowId: string, label: string) => {
            const draft = (await as(user)('GET', `/flows/${flowId}/draft`)).body;
            draft.flow.nodes = draft.flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label } : n));
            return as(user)('PUT', `/flows/${flowId}/draft`, { revision: draft.revision, flow: draft.flow });
        };
        return { id, as, call, projectId, orders, repo, slug, at, handle, show, changes, relabel };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-work-branches-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("a branch made from dev is cut from its tip and pushed at once; it takes only one's own changes, which leave dev", async () => {
        const { as, call, projectId, orders, repo, at, handle, changes, relabel } = await workspace();
        const ana = await handle(ANA);
        expect((await relabel(ANA, orders, 'Ana was here')).status).toBe(200);
        expect((await as(BIA)('POST', `/projects/${projectId}/flows`, { name: 'Refunds' })).status).toBe(201);
        expect(await changes(ANA)).toEqual([at('projects/Sales/flows/Orders.flow.yaml'), at('projects/Sales/flows/Refunds.flow.yaml')]);

        const branch = `users/${ana}/labels`;
        const created = await call('POST', '/git/branches', { name: branch });
        expect(created.status).toBe(201);
        expect(created.body).toEqual({ branch, taken: [at('projects/Sales/flows/Orders.flow.yaml')] });
        expect(git(repo, 'rev-parse', branch)).toBe(git(repo, 'rev-parse', 'dev'));

        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch, editable: true });
        expect(await changes(ANA)).toEqual([at('projects/Sales/flows/Orders.flow.yaml')]);
        const draft = (await call('GET', `/flows/${orders}/draft`)).body;
        expect(draft.flow.nodes.find((n: { type: string }) => n.type === 'start').label).toBe('Ana was here');
        const listed = (await call('GET', '/git/branches')).body.branches as { name: string; changes: number; editable: boolean }[];
        expect(listed.find(b => b.name === branch)).toMatchObject({ changes: 1, editable: true });

        expect(await changes(BIA)).toEqual([at('projects/Sales/flows/Refunds.flow.yaml')]);
        const onDev = (await as(BIA)('GET', `/flows/${orders}/draft`)).body;
        expect(onDev.flow.nodes.find((n: { type: string }) => n.type === 'start').label).not.toBe('Ana was here');

        expect((await call('PUT', '/git/current-branch', { branch: 'dev' })).status).toBe(200);
        expect(await changes(ANA)).toEqual([at('projects/Sales/flows/Refunds.flow.yaml')]);
        expect((await call('PUT', '/git/current-branch', { branch })).status).toBe(200);
        expect(await changes(ANA)).toEqual([at('projects/Sales/flows/Orders.flow.yaml')]);

        expect((await call('PATCH', `/flows/${orders}`, { name: 'Orders 2' })).status).toBe(200);
        expect(await changes(ANA)).toEqual([
            `${at('projects/Sales/flows/Orders.flow.yaml')} -> ${at('projects/Sales/flows/Orders 2.flow.yaml')}`,
        ]);
        const counted = (await call('GET', '/git/branches')).body.branches as { name: string; changes: number }[];
        expect(counted.find(b => b.name === branch)?.changes).toBe(1);
        expect((await call('GET', '/projects')).body.items[0].summary).toEqual({ flows: 1, deployed: 1, scripts: 0 });
        expect((await call('POST', `/projects/${projectId}/flows`, { name: 'Not deployed' })).status).toBe(201);
        expect((await call('GET', '/projects')).body.items[0].summary).toEqual({ flows: 2, deployed: 1, scripts: 0 });
    });

    test('a new flow taken from dev to a branch leaves no row on dev', async () => {
        const { id, call, projectId, at, handle, changes } = await workspace();
        expect((await call('POST', `/projects/${projectId}/flows`, { name: 'Fresh' })).status).toBe(201);
        const created = await call('POST', '/git/branches', { name: `users/${await handle(ANA)}/fresh` });
        expect(created.body.taken).toEqual([at('projects/Sales/flows/Fresh.flow.yaml')]);
        expect(await changes(ANA)).toEqual([at('projects/Sales/flows/Fresh.flow.yaml')]);
        expect(
            await db.query("SELECT path FROM working_copy WHERE workspace_id = $1 AND branch = '' AND deleted AND base IS NULL", [id]),
        ).toEqual([]);
    });

    test('edits on a work branch go into its working copy, and a Commit pushes them to that branch, read back with git', async () => {
        const { call, projectId, orders, repo, at, handle, show, changes, relabel } = await workspace();
        const branch = `users/${await handle(ANA)}/work`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);

        expect((await relabel(ANA, orders, 'Branch start')).status).toBe(200);
        const later = (await call('POST', `/projects/${projectId}/folders`, { name: 'Later' })).body.id as string;
        const created = await call('POST', `/projects/${projectId}/flows`, { name: 'Restock', folderId: later });
        expect(created.status).toBe(201);
        const restock = created.body.id as string;
        const script = await call('POST', `/projects/${projectId}/scripts`, {
            path: 'util',
            kind: 'script',
            content: 'export const n = 1;\n',
        });
        expect(script.status).toBe(201);
        expect((await call('PATCH', `/flows/${restock}`, { name: 'Restock all' })).status).toBe(200);

        const contents = (await call('GET', `/projects/${projectId}/contents`)).body;
        expect(contents.folders.map((f: { id: string; name: string }) => [f.id, f.name])).toEqual([[later, 'Later']]);
        expect(contents.flows.map((f: { name: string; folderId: string | null }) => [f.name, f.folderId])).toEqual([
            ['Orders', null],
            ['Restock all', later],
        ]);
        expect(await changes(ANA)).toEqual([
            at('projects/Sales/flows/Later/Restock all.flow.yaml'),
            at('projects/Sales/flows/Orders.flow.yaml'),
            at('projects/Sales/scripts/util.ts'),
        ]);

        const devTip = git(repo, 'rev-parse', 'dev');
        const committed = await commitAll(call, 'Work on a branch');
        expect(committed.status).toBe(200);
        expect(git(repo, 'rev-parse', branch)).toBe(committed.body.commit);
        expect(git(repo, 'rev-parse', `${branch}^`)).toBe(devTip);
        expect(git(repo, 'rev-parse', 'dev')).toBe(devTip);
        expect(show(branch, 'projects/Sales/flows/Orders.flow.yaml')).toContain('label: Branch start');
        expect(show(branch, 'projects/Sales/flows/Later/Restock all.flow.yaml')).toContain(`id: ${restock}`);
        expect(show(branch, 'projects/Sales/scripts/util.ts')).toBe('export const n = 1;');
        expect(git(repo, 'ls-tree', '-r', '--name-only', branch)).not.toContain('Later/.gitkeep');
        expect(await changes(ANA)).toEqual([]);

        expect((await call('GET', `/flows/${restock}`)).body).toMatchObject({ name: 'Restock all', folderId: later });

        expect((await call('POST', `/flows/${restock}/archive`)).status).toBe(200);
        expect(await changes(ANA)).toEqual([
            at('projects/Sales/flows/Later/.gitkeep'),
            at('projects/Sales/flows/Later/Restock all.flow.yaml'),
        ]);
        expect((await call('GET', `/flows/${restock}`)).status).toBe(404);
        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect((await call('GET', `/flows/${restock}`)).status).toBe(200);
        expect(await changes(ANA)).toEqual([]);
    });

    test('on a users/ branch only its owner edits or commits; another user opens it and creates a branch from it', async () => {
        const { as, call, orders, repo, at, handle, changes, relabel } = await workspace();
        const ana = await handle(ANA);
        const bia = await handle(BIA);
        const branch = `users/${ana}/mine`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        expect((await relabel(ANA, orders, 'Ana only')).status).toBe(200);
        const anaTip = (await commitAll(call, 'Ana only')).body.commit as string;

        const asBia = as(BIA);
        expect((await asBia('PUT', '/git/current-branch', { branch })).body).toEqual({ branch, editable: false });
        const draft = (await asBia('GET', `/flows/${orders}/draft`)).body;
        expect(draft.flow.nodes.find((n: { type: string }) => n.type === 'start').label).toBe('Ana only');
        const refused = await relabel(BIA, orders, 'Bia too');
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toContain(`only its owner`);
        expect((await asBia('POST', '/git/commit', { paths: [at('projects/Sales/flows/Orders.flow.yaml')], message: 'x' })).status).toBe(
            409,
        );
        expect((await asBia('POST', `/flows/${orders}/archive`)).status).toBe(409);
        expect((await asBia('POST', '/git/branches', { name: `users/${ana}/sneaky` })).status).toBe(400);

        const hers = `users/${bia}/from-ana`;
        const created = await asBia('POST', '/git/branches', { name: hers });
        expect(created.status).toBe(201);
        expect(created.body.taken).toEqual([]);
        expect(git(repo, 'rev-parse', hers)).toBe(anaTip);
        expect((await relabel(BIA, orders, 'Bia on hers')).status).toBe(200);
        expect(await changes(BIA)).toEqual([at('projects/Sales/flows/Orders.flow.yaml')]);
        expect((await call('PUT', '/git/current-branch', { branch: hers })).body.editable).toBe(false);
    });

    test("from one's own branch every change goes along; from a shared branch only one's own", async () => {
        const { as, call, projectId, orders, at, handle, changes, relabel } = await workspace();
        const ana = await handle(ANA);
        expect((await call('POST', '/git/branches', { name: 'fix/shared' })).status).toBe(201);
        expect((await as(BIA)('PUT', '/git/current-branch', { branch: 'fix/shared' })).body.editable).toBe(true);
        expect((await relabel(ANA, orders, 'Ana on shared')).status).toBe(200);
        expect((await as(BIA)('POST', `/projects/${projectId}/flows`, { name: 'Bia on shared' })).status).toBe(201);

        const first = `users/${ana}/first`;
        const taken = await call('POST', '/git/branches', { name: first });
        expect(taken.body.taken).toEqual([at('projects/Sales/flows/Orders.flow.yaml')]);
        expect(await changes(BIA)).toEqual([at('projects/Sales/flows/Bia on shared.flow.yaml')]);

        expect((await call('POST', `/projects/${projectId}/folders`, { name: 'Mine' })).status).toBe(201);
        const second = await call('POST', '/git/branches', { name: `users/${ana}/second` });
        expect(second.body.taken).toEqual([at('projects/Sales/flows/Mine/.gitkeep'), at('projects/Sales/flows/Orders.flow.yaml')]);
        expect((await call('PUT', '/git/current-branch', { branch: first })).status).toBe(200);
        expect(await changes(ANA)).toEqual([]);
    });

    test('the tree is validated before a push on a work branch: an invalid one is refused with its errors', async () => {
        const { id, call, orders, repo, at, handle, relabel } = await workspace();
        const branch = `users/${await handle(ANA)}/broken`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        const caller = newFlowFile('Caller', crypto.randomUUID());
        caller.nodes.push({ id: 'call', type: 'flow', position: { x: 160, y: 0 }, config: { flowId: crypto.randomUUID() } });
        const files: Record<string, string> = {};
        for (const path of git(repo, 'ls-tree', '-r', '--name-only', branch).split('\n').filter(Boolean)) {
            files[path] = git(repo, 'show', `${branch}:${path}`) + '\n';
        }
        files[at('projects/Sales/flows/Caller.flow.yaml')] = repoFlowToYaml(caller);
        commitFiles(repo, branch, files, 'from a laptop');
        await app.gitPoller.poll(id);

        expect((await relabel(ANA, orders, 'Valid edit')).status).toBe(200);
        const before = git(repo, 'rev-parse', branch);
        const refused = await commitAll(call, 'On a broken tree');
        expect(refused.status).toBe(400);
        expect(refused.body.error.message).toContain('would not be valid');
        expect(Object.keys(refused.body.error.fields ?? {})).toContain(at('projects/Sales/flows/Caller.flow.yaml'));
        expect(git(repo, 'rev-parse', branch)).toBe(before);
    });
});
