import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ANA, BIA, insertMember, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { API_SCOPES, insertApiToken, newApiToken } from '#features/api-tokens/api-tokens';
import { PROTECTED_TRIGGERS } from '#features/flows/flow-triggers/flow-triggers-handlers';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Mode = 'direct' | 'pull-request' | 'protected';

describe('hotfix branches: cut from a protected environment, shared on its server, read only elsewhere', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);
    const clients: Client[] = [];

    async function workspace(mode: Mode = 'protected') {
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

        const handle = workspaceHandleOf(id);
        const ordersPath = `${handle}/projects/Sales/flows/Orders.flow.yaml`;
        const tip = (branch = 'dev') => git(repo, 'rev-parse', branch);
        const show = (ref: string, file: string) =>
            Bun.spawnSync(['git', 'show', `${ref}:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        const filesOf = (ref: string): Record<string, string> =>
            Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', ref)
                    .split('\n')
                    .filter(Boolean)
                    .map(file => [file, show(ref, file)]),
            );
        const userHandle = async (user: string) => (await as(user)('GET', '/me')).body.handle as string;
        const relabelled = async (user: string, flowId: string, label: string) => {
            const draft = (await as(user)('GET', `/flows/${flowId}/draft`)).body;
            const nodes = draft.flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label } : n));
            return { revision: draft.revision as number, flow: { ...draft.flow, nodes } };
        };
        const changes = async (user: string) =>
            ((await as(user)('GET', '/git/changes')).body.changes as { path: string; mine: boolean }[]).map(c => [c.path, c.mine]);
        const setMode = async (next: Mode) => {
            const topology = git(repo, 'show', 'flowtinus/config:topology.yaml');
            commitFiles(repo, 'flowtinus/config', { 'topology.yaml': `${topology.replace(/mode: [a-z-]+/, `mode: ${next}`)}\n` }, next);
            expect((await call('POST', '/git/reconcile')).status).toBe(200);
            expect((await call('GET', '/git/status')).body.mode).toBe(next);
        };
        const mcp = async (user: string) => {
            const { token } = newApiToken();
            await insertApiToken(db, { userId: user, name: `test-${crypto.randomUUID()}`, token, scopes: API_SCOPES });
            const client = new Client({ name: 'test', version: '1.0.0' });
            await client.connect(
                new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                    requestInit: { headers: { authorization: `Bearer ${token}` } },
                    fetch: (url, init) => Promise.resolve(app.request(String(url), init as RequestInit)),
                }),
            );
            clients.push(client);
            return async (name: string, args: Record<string, unknown> = {}) => {
                const answer = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
                return { isError: answer.isError, body: JSON.parse(answer.content[0]!.text) };
            };
        };
        if (mode !== 'direct') {
            await setMode(mode);
        }
        await app.gitPoller.poll(id);
        return { id, as, call, projectId, orders, ordersPath, repo, tip, filesOf, userHandle, relabelled, changes, setMode, mcp };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-hotfix-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        for (const client of clients) {
            await client.close();
        }
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("Create hotfix pushes hotfix/<name> at the environment's tip and puts the editor on it; refused when it exists", async () => {
        const { id, as, call, repo, tip } = await workspace();
        const editor = await insertMember(db, id, { name: 'Eva', role: 'editor' });

        const created = await as(editor)('POST', '/git/hotfix', { name: 'urgent' });
        expect([created.status, created.body]).toEqual([201, { branch: 'hotfix/urgent' }]);
        expect(git(repo, 'rev-parse', 'hotfix/urgent')).toBe(tip());
        expect((await as(editor)('GET', '/git/current-branch')).body).toEqual({ branch: 'hotfix/urgent', editable: true });
        expect((await call('GET', '/git/current-branch')).body.branch).toBe('dev');

        const again = await call('POST', '/git/hotfix', { name: 'Urgent' });
        expect([again.status, again.body.error.fields]).toEqual([409, { name: 'Already exists' }]);
        const invalid = await call('POST', '/git/hotfix', { name: 'a..b' });
        expect([invalid.status, invalid.body.error.fields]).toEqual([400, { name: 'Not a valid branch name' }]);
        const viewer = await insertMember(db, id, { name: 'Vic', role: 'viewer' });
        expect((await as(viewer)('POST', '/git/hotfix', { name: 'mine' })).status).toBe(403);
    });

    test('Create hotfix is refused on a server that is not protected, and a hotfix/ name is refused by Create branch', async () => {
        const { call, repo, userHandle, setMode } = await workspace('direct');
        const refused = await call('POST', '/git/hotfix', { name: 'urgent' });
        expect([refused.status, refused.body.error.message]).toEqual([
            409,
            "Only a protected environment's server creates hotfixes: create a branch instead.",
        ]);
        const named = await call('POST', '/git/branches', { name: 'hotfix/urgent' });
        expect([named.status, named.body.error.fields]).toEqual([400, { name: 'That name is kept for the branches the app makes.' }]);

        await setMode('pull-request');
        expect((await call('POST', '/git/hotfix', { name: 'urgent' })).status).toBe(409);
        expect(git(repo, 'branch', '--list', 'hotfix/*')).toBe('');
        expect((await call('POST', '/git/branches', { name: `users/${await userHandle(ANA)}/x` })).status).toBe(201);
    });

    test("a hotfix is shared: any editor edits it, a trigger and a connection included; a Commit takes one's own files", async () => {
        const { as, call, orders, ordersPath, repo, tip, relabelled, changes, mcp } = await workspace();
        const before = tip();
        expect((await call('POST', '/git/hotfix', { name: 'urgent' })).status).toBe(201);
        expect((await as(BIA)('PUT', '/git/current-branch', { branch: 'hotfix/urgent' })).body).toEqual({
            branch: 'hotfix/urgent',
            editable: true,
        });

        expect((await as(BIA)('PUT', `/flows/${orders}/draft`, await relabelled(BIA, orders, 'Bia fixes'))).status).toBe(200);
        const schedule = await as(BIA)('POST', `/flows/${orders}/triggers/schedules`, { cron: '0 6 * * *', timezone: 'UTC' });
        expect(schedule.status).toBe(201);
        expect((await as(BIA)('GET', `/flows/${orders}/triggers`)).body.file).toEqual({ editable: true });
        const connection = await call('POST', '/connections', { name: 'Warehouse', type: 'http-client', config: { auth: 'none' } });
        expect(connection.status).toBe(201);
        const connectionPath = (await changes(ANA)).find(([path]) => String(path).includes('connections'))![0] as string;
        expect((await changes(ANA)).sort()).toEqual(
            [
                [ordersPath, false],
                [connectionPath, true],
            ].sort(),
        );

        const committed = await call('POST', '/git/commit', { paths: [connectionPath], message: 'A connection' });
        expect(committed.status).toBe(200);
        expect(git(repo, 'ls-tree', '--name-only', 'hotfix/urgent', connectionPath)).toBe(connectionPath);
        expect((await changes(BIA)).map(([path]) => path)).toEqual([ordersPath]);
        expect((await commitAll(as(BIA), 'Bia fixes')).status).toBe(200);
        expect(git(repo, 'show', `hotfix/urgent:${ordersPath}`)).toContain('Bia fixes');
        expect(git(repo, 'show', `hotfix/urgent:${ordersPath}`)).toContain('0 6 * * *');

        const tool = await mcp(BIA);
        const read = await tool('get_flow', { flowId: orders });
        const saved = await tool('create_folder', { projectId: read.body.projectId, name: 'Imports' });
        expect(saved.isError).toBeFalsy();
        expect(tip()).toBe(before);
    });

    test("the environment's branch stays read only on a protected server: no trigger, no connection, no pull request", async () => {
        const { call, orders } = await workspace();
        expect((await call('POST', '/git/hotfix', { name: 'urgent' })).status).toBe(201);
        expect((await call('PUT', '/git/current-branch', { branch: 'dev' })).status).toBe(200);

        const schedule = await call('POST', `/flows/${orders}/triggers/schedules`, { cron: '0 6 * * *', timezone: 'UTC' });
        expect([schedule.status, schedule.body.error.message]).toEqual([409, PROTECTED_TRIGGERS]);
        const connection = await call('POST', '/connections', { name: 'Warehouse', type: 'http-client', config: { auth: 'none' } });
        expect([connection.status, connection.body.error.message]).toEqual([409, 'DEV only takes pull requests: edit in git.']);
        const proposed = await call('POST', '/git/pull-request');
        expect([proposed.status, proposed.body.error.message]).toEqual([
            409,
            'dev is protected: its server opens no pull request from a work branch.',
        ]);
    });

    test('a hotfix/ branch pushed by hand on a server that is not protected stays read only, for the editor and the MCP', async () => {
        const { call, orders, repo, tip, relabelled, mcp, id } = await workspace('direct');
        git(repo, 'update-ref', 'refs/heads/hotfix/by-hand', tip());
        await app.gitPoller.poll(id);

        const listed = (await call('GET', '/git/branches')).body.branches as { name: string }[];
        expect(listed.map(b => b.name)).toEqual(['dev']);
        expect((await call('PUT', '/git/current-branch', { branch: 'hotfix/by-hand' })).body).toEqual({
            branch: 'hotfix/by-hand',
            editable: false,
        });
        const save = await call('PUT', `/flows/${orders}/draft`, await relabelled(ANA, orders, 'By hand'));
        expect([save.status, save.body.error.message]).toEqual([
            409,
            "You are on the branch hotfix/by-hand, which is read only here: pick the environment's branch to make changes.",
        ]);
        const tool = await mcp(ANA);
        const read = await tool('get_flow', { flowId: orders });
        const refused = await tool('create_folder', { projectId: read.body.projectId, name: 'Imports' });
        expect(refused.isError).toBe(true);
        expect((await call('POST', '/git/pull-request')).status).toBe(409);
    });

    test('the protected picker lists only the environment and the hotfixes; a hotfix the environment contains is merged', async () => {
        const { call, repo, tip, filesOf, userHandle, id } = await workspace();
        git(repo, 'update-ref', `refs/heads/users/${await userHandle(ANA)}/try`, tip());
        git(repo, 'update-ref', 'refs/heads/fix/shared', tip());
        git(repo, 'update-ref', 'refs/heads/promote/DEV-0123456789ab', tip());
        expect((await call('POST', '/git/hotfix', { name: 'urgent' })).status).toBe(201);
        await app.gitPoller.poll(id);

        const branches = async () =>
            (
                (await call('GET', '/git/branches')).body.branches as { name: string; kind: string; editable: boolean; merged: boolean }[]
            ).map(b => [b.name, b.kind, b.editable, b.merged]);
        expect(await branches()).toEqual([
            ['dev', 'environment', true, false],
            ['hotfix/urgent', 'hotfix', true, false],
        ]);

        const fixed = commitFiles(repo, 'hotfix/urgent', { ...filesOf('hotfix/urgent'), 'fix.txt': 'fix' }, 'A fix');
        git(repo, 'update-ref', 'refs/heads/dev', fixed);
        await app.gitPoller.poll(id);
        expect((await branches())[1]).toEqual(['hotfix/urgent', 'hotfix', true, true]);
    });

    test("Update on a hotfix merges the environment's branch into it", async () => {
        const { call, repo, tip, filesOf } = await workspace();
        expect((await call('POST', '/git/hotfix', { name: 'urgent' })).status).toBe(201);
        commitFiles(repo, 'dev', { ...filesOf('dev'), 'promoted.txt': 'promoted' }, 'A promotion landed');
        expect((await call('POST', '/git/reconcile')).status).toBe(200);

        expect((await call('GET', '/git/update')).body).toEqual({ branch: 'hotfix/urgent', environment: 'dev', behind: 1 });
        const updated = await call('POST', '/git/update');
        expect(updated.body.outcome).toBe('merged');
        expect(git(repo, 'rev-list', '--parents', '-n', '1', 'hotfix/urgent').split(' ').slice(1)[1]).toBe(tip());
        expect((await call('POST', '/git/update')).body).toEqual({ outcome: 'up-to-date' });
    });

    test("Open pull request on a hotfix links into the environment's branch; an invalid tip is refused before it is pushed back", async () => {
        const { call, orders, ordersPath, repo, relabelled, filesOf } = await workspace();
        expect((await call('POST', '/git/hotfix', { name: 'urgent' })).status).toBe(201);
        expect((await call('PUT', `/flows/${orders}/draft`, await relabelled(ANA, orders, 'Fixed'))).status).toBe(200);
        expect((await commitAll(call, 'Fixed')).status).toBe(200);

        const proposed = await call('POST', '/git/pull-request');
        expect(proposed.status).toBe(200);
        expect(proposed.body).toMatchObject({ branch: 'hotfix/urgent', target: 'dev', commits: 1, borrowed: [] });

        commitFiles(repo, 'hotfix/urgent', { ...filesOf('hotfix/urgent'), [ordersPath]: 'nodes: 1\n' }, 'Broken by hand');
        expect((await call('POST', '/git/reconcile')).status).toBe(200);
        git(repo, 'update-ref', '-d', 'refs/heads/hotfix/urgent');
        const invalid = await call('POST', '/git/pull-request');
        expect(invalid.status).toBe(400);
        expect(Object.keys(invalid.body.error.fields)).toEqual([ordersPath]);
        expect(git(repo, 'branch', '--list', 'hotfix/urgent')).toBe('');
    });
});
