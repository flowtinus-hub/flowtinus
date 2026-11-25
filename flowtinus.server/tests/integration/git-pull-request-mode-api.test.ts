import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ANA, BIA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { API_SCOPES, insertApiToken, newApiToken } from '#features/api-tokens/api-tokens';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Mode = 'direct' | 'pull-request' | 'protected';
type ToolAnswer = { isError?: boolean; body: any };

const NUMBERS = `version: 1
name: Numbers
nodes:
  - { id: start, type: start, position: { x: 0, y: 0 }, config: {} }
  - id: grid
    type: datagrid
    position: { x: 300, y: 0 }
    config:
      columns: [{ name: n, type: number }]
      rows: [['1']]
  - { id: end, type: end, position: { x: 600, y: 0 }, config: {} }
edges:
  - { source: start, sourcePort: out-0, target: grid, targetPort: in-0 }
  - { source: grid, sourcePort: out-0, target: end, targetPort: in-0 }
`;

const labelled = (label: string) => NUMBERS.replace('type: start,', `type: start, label: ${label},`);

describe('pull-request servers offer Create branch; the MCP acts on the current branch', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);
    const clients: Client[] = [];

    async function workspace() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        // a live supervisor, or a test run finds no worker for its tag
        await db.query(`UPDATE supervisors SET last_seen = now() WHERE id = 'sup-git-pull-request'`);
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
        expect(
            (await call('POST', `/projects/${projectId}/scripts`, { kind: 'script', path: 'lib/prices', content: 'export const a = 1;' }))
                .status,
        ).toBe(201);
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

        const handle = workspaceHandleOf(id);
        const at = (path: string) => `${handle}/${path}`;
        const userHandle = async (user: string) => (await as(user)('GET', '/me')).body.handle as string;
        const tip = (branch = 'dev') => git(repo, 'rev-parse', branch);
        const changes = async (user: string) =>
            ((await as(user)('GET', '/git/changes')).body.changes as { path: string }[]).map(c => c.path);
        const relabelled = async (user: string, flowId: string, label: string) => {
            const draft = (await as(user)('GET', `/flows/${flowId}/draft`)).body;
            const nodes = draft.flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label } : n));
            return { revision: draft.revision as number, flow: { ...draft.flow, nodes } };
        };
        const startLabel = async (user: string, flowId: string) =>
            (await as(user)('GET', `/flows/${flowId}/draft`)).body.flow.nodes.find((n: { type: string }) => n.type === 'start').label;
        const setMode = async (mode: Mode) => {
            const topology = git(repo, 'show', 'flowtinus/config:topology.yaml');
            commitFiles(repo, 'flowtinus/config', { 'topology.yaml': `${topology.replace(/mode: [a-z-]+/, `mode: ${mode}`)}\n` }, mode);
            expect((await call('POST', '/git/reconcile')).status).toBe(200);
            expect((await call('GET', '/git/status')).body.mode).toBe(mode);
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
            const tool = async (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
                const answer = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
                return { isError: answer.isError, body: JSON.parse(answer.content[0]!.text) };
            };
            return { client, tool };
        };
        return { id, as, call, projectId, orders, repo, handle, at, userHandle, tip, changes, relabelled, startLabel, setMode, mcp };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-pull-request-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-git-pull-request', '{default}', 1, 'test')`);
    });

    afterAll(async () => {
        for (const client of clients) {
            await client.close();
        }
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    const PULL_REQUESTS = 'dev only takes pull requests: create a branch of your own to make changes.';

    test("pull-request: the environment's branch takes no change and no Commit; drafts made before stay; a test run works", async () => {
        const { as, call, projectId, orders, at, tip, changes, relabelled, startLabel, setMode } = await workspace();
        const ordersPath = at('projects/Sales/flows/Orders.flow.yaml');
        expect((await call('PUT', `/flows/${orders}/draft`, await relabelled(ANA, orders, 'Before'))).status).toBe(200);
        await setMode('pull-request');
        const before = tip();

        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch: 'dev', editable: false, offersBranch: true });
        expect((await call('GET', `/flows/${orders}`)).body.offersBranch).toBe(true);
        const listed = (await call('GET', '/git/branches')).body.branches as { name: string; editable: boolean }[];
        expect(listed.find(b => b.name === 'dev')?.editable).toBe(false);

        const scripts = `/projects/${projectId}/scripts`;
        for (const [method, path, body] of [
            ['PUT', `/flows/${orders}/draft`, await relabelled(ANA, orders, 'After')],
            ['PUT', `${scripts}/content`, { path: 'lib/prices', content: 'export const a = 2;', revision: 0 }],
            ['POST', `/projects/${projectId}/folders`, { name: 'Imports' }],
            ['PATCH', `/flows/${orders}`, { name: 'Sales orders' }],
            ['POST', '/projects', { name: 'Billing' }],
            ['POST', '/git/commit', { paths: [ordersPath], message: 'Before' }],
            ['POST', `/flows/${orders}/deploy`, { message: 'Before' }],
        ] as const) {
            const refused = await call(method, path, body);
            expect({ path, status: refused.status, message: refused.body.error?.message }).toEqual({
                path,
                status: 409,
                message: PULL_REQUESTS,
            });
        }
        expect(tip()).toBe(before);

        expect(await changes(ANA)).toEqual([ordersPath]);
        expect(await startLabel(BIA, orders)).toBe('Before');
        expect((await as(BIA)('POST', `/flows/${orders}/runs`, { mode: 'validation' })).status).toBe(202);
    });

    test("pull-request: the changes made before are discarded on the environment's branch, a file or all one's own; edits and Commit stay refused", async () => {
        const { as, call, projectId, orders, at, tip, changes, relabelled, startLabel, setMode } = await workspace();
        const ordersPath = at('projects/Sales/flows/Orders.flow.yaml');
        expect((await call('PUT', `/flows/${orders}/draft`, await relabelled(ANA, orders, 'Before'))).status).toBe(200);
        expect((await call('POST', `/projects/${projectId}/folders`, { name: 'Imports' })).status).toBe(201);
        expect((await as(BIA)('POST', `/projects/${projectId}/folders`, { name: 'Reports' })).status).toBe(201);
        await setMode('pull-request');
        const before = tip();
        const listed = await changes(ANA);
        const imports = listed.find(path => path.includes('Imports'))!;
        const reports = listed.find(path => path.includes('Reports'))!;
        expect(listed.sort()).toEqual([imports, ordersPath, reports].sort());

        const file = await call('POST', '/git/discard', { paths: [ordersPath] });
        expect(file.status).toBe(200);
        expect(file.body.discarded).toEqual([ordersPath]);
        expect(await startLabel(ANA, orders)).toBeUndefined();
        expect((await changes(ANA)).sort()).toEqual([imports, reports].sort());

        const mine = await call('POST', '/git/discard', { mine: true });
        expect(mine.status).toBe(200);
        expect(mine.body.discarded).toEqual([imports]);
        expect(await changes(ANA)).toEqual([reports]);
        const folders = (await call('GET', `/projects/${projectId}/contents`)).body.folders as {
            name: string;
            archivedAt: string | null;
        }[];
        expect(folders.filter(f => !f.archivedAt).map(f => f.name)).toEqual(['Reports']);

        for (const [method, path, body] of [
            ['PUT', `/flows/${orders}/draft`, await relabelled(ANA, orders, 'After')],
            ['POST', `/projects/${projectId}/folders`, { name: 'Imports' }],
            ['POST', '/git/commit', { paths: [reports], message: 'Reports' }],
            ['POST', `/flows/${orders}/deploy`, { message: 'Before' }],
        ] as const) {
            const refused = await call(method, path, body);
            expect({ path, status: refused.status, message: refused.body.error?.message }).toEqual({
                path,
                status: 409,
                message: PULL_REQUESTS,
            });
        }
        expect(tip()).toBe(before);
        expect(await changes(BIA)).toEqual([reports]);
    });

    test('pull-request: Create branch from the first edit takes it along to users/<handle>/…; a Commit there is pushed', async () => {
        const { as, call, orders, repo, at, userHandle, tip, changes, relabelled, startLabel, setMode } = await workspace();
        const ordersPath = at('projects/Sales/flows/Orders.flow.yaml');
        expect((await call('PUT', `/flows/${orders}/draft`, await relabelled(ANA, orders, 'Ana before'))).status).toBe(200);
        await setMode('pull-request');
        const before = tip();

        const bia = await userHandle(BIA);
        const branch = `users/${bia}/Orders`;
        const { flow } = await relabelled(BIA, orders, 'Bia on her branch');
        const created = await as(BIA)('POST', '/git/branches', { name: branch, draft: { flowId: orders, flow } });
        expect(created.status).toBe(201);
        expect(created.body).toEqual({ branch, taken: [], draft: { revision: 1 } });
        expect(git(repo, 'rev-parse', branch)).toBe(before);
        expect((await as(BIA)('GET', '/git/current-branch')).body).toEqual({ branch, editable: true });
        expect(await startLabel(BIA, orders)).toBe('Bia on her branch');
        expect(await changes(BIA)).toEqual([ordersPath]);
        expect(await changes(ANA)).toEqual([ordersPath]);
        expect(await startLabel(ANA, orders)).toBe('Ana before');

        const again = await relabelled(BIA, orders, 'Bia again');
        expect((await as(BIA)('PUT', `/flows/${orders}/draft`, again)).status).toBe(200);
        const committed = await as(BIA)('POST', '/git/commit', { paths: [ordersPath], message: 'Bia relabels' });
        expect(committed.status).toBe(200);
        expect(git(repo, 'show', `${branch}:${ordersPath}`)).toContain('Bia again');
        expect(tip()).toBe(before);

        const ana = await userHandle(ANA);
        const hers = await call('POST', '/git/branches', { name: `users/${ana}/before` });
        expect(hers.body).toEqual({ branch: `users/${ana}/before`, taken: [ordersPath] });
        expect(await changes(ANA)).toEqual([ordersPath]);
        expect((await call('PUT', '/git/current-branch', { branch: 'dev' })).status).toBe(200);
        expect(await changes(ANA)).toEqual([]);

        const invalid = await as(BIA)('POST', '/git/branches', {
            name: `users/${bia}/broken`,
            draft: { flowId: orders, flow: { nodes: 1 } },
        });
        expect(invalid.status).toBe(400);
        expect(git(repo, 'branch', '--list', `users/${bia}/broken`)).toBe('');
    });

    test('protected: changes refused as step 2 left them, work branches read only, no branch is created', async () => {
        const { as, call, projectId, orders, repo, userHandle, tip, relabelled, setMode, id } = await workspace();
        const ana = await userHandle(ANA);
        git(repo, 'update-ref', `refs/heads/users/${ana}/try`, tip());
        git(repo, 'update-ref', 'refs/heads/fix/shared', tip());
        await setMode('protected');
        await app.gitPoller.poll(id);
        const before = tip();

        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch: 'dev', editable: true });
        expect((await call('PUT', `/flows/${orders}/draft`, await relabelled(ANA, orders, 'Draft'))).status).toBe(200);
        const folder = await call('POST', `/projects/${projectId}/folders`, { name: 'Imports' });
        expect([folder.status, folder.body.error.message]).toEqual([409, 'DEV only takes pull requests: edit in git.']);
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(409);

        const listed = (await call('GET', '/git/branches')).body.branches as { name: string; editable: boolean }[];
        expect(listed.map(b => [b.name, b.editable])).toEqual([['dev', true]]);
        const refused = await call('POST', '/git/branches', { name: `users/${ana}/new` });
        expect(refused.status).toBe(409);

        for (const branch of [`users/${ana}/try`, 'fix/shared']) {
            expect((await call('PUT', '/git/current-branch', { branch })).body).toEqual({ branch, editable: false });
            expect((await call('GET', `/flows/${orders}`)).body.readOnly).toBe(true);
            const save = await call('PUT', `/flows/${orders}/draft`, await relabelled(ANA, orders, 'On a branch'));
            expect([save.status, save.body.error.message]).toEqual([
                409,
                `This server's environment is protected: the branch ${branch} is read only here.`,
            ]);
        }
        expect(tip()).toBe(before);
        expect(git(repo, 'branch', '--list', `users/${ana}/new`)).toBe('');
        expect((await as(BIA)('GET', '/git/current-branch')).body.editable).toBe(true);
    });

    test('the MCP reads and writes the current branch: a flow only there, its draft, a script, a test run; dev untouched', async () => {
        const { call, projectId, orders, at, userHandle, changes, mcp } = await workspace();
        const { client, tool } = await mcp(ANA);
        const names = (await client.listTools()).tools.map(t => t.name);
        expect(names.filter(name => /branch|commit/.test(name))).toEqual([]);

        const branch = `users/${await userHandle(ANA)}/agent`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);

        const created = await tool('create_flow', { projectId, name: 'Numbers', yaml: NUMBERS });
        expect(created.body.error).toBeUndefined();
        const numbers = created.body.flowId as string;
        expect(created.body.revision).toBe(1);
        expect((await db.query('SELECT id FROM flows WHERE id = $1', [numbers])).length).toBe(0);
        const read = await tool('get_flow', { flowId: numbers });
        expect(read.isError).toBeFalsy();
        expect(read.body.revision).toBe(1);
        const saved = await tool('save_draft', { flowId: numbers, yaml: labelled('Agent'), expectedRevision: 1 });
        expect(saved.isError).toBeFalsy();
        expect(saved.body.revision).toBe(2);
        const contents = await tool('get_project_contents', { projectId });
        expect(JSON.stringify(contents.body)).toContain(numbers);

        const calling = NUMBERS.replace(
            '  - { id: end, type: end',
            `  - { id: call, type: flow, position: { x: 150, y: 100 }, config: { flowId: '${numbers}' } }\n  - { id: end, type: end`,
        );
        const checked = await tool('validate_flow', { projectId, yaml: calling });
        expect(checked.body.issues.filter((i: { settingKey?: string }) => i.settingKey === 'flowId')).toEqual([]);

        const script = await tool('save_script', { projectId, path: 'lib/tax', content: 'export const rate = 0.2;\n' });
        expect(script.isError).toBeFalsy();
        expect((await tool('list_scripts', { projectId })).body.scripts.map((s: { path: string }) => s.path)).toEqual([
            'lib/prices',
            'lib/tax',
        ]);
        const run = await tool('test_run', { flowId: numbers, timeoutS: 0 });
        expect(run.isError).toBeFalsy();

        expect(await changes(ANA)).toEqual([at('projects/Sales/flows/Numbers.flow.yaml'), at('projects/Sales/scripts/lib/tax.ts')]);
        expect((await call('PUT', '/git/current-branch', { branch: 'dev' })).status).toBe(200);
        expect(await changes(ANA)).toEqual([]);
        expect((await tool('get_flow', { flowId: numbers })).body.error.code).toBe('not-found');
        expect((await tool('get_flow', { flowId: orders })).isError).toBeFalsy();
    });

    test("the MCP refuses to change another user's branch and a pull-request environment's branch, saying to pick or create one", async () => {
        const { call, as, projectId, orders, userHandle, mcp, setMode } = await workspace();
        const ana = await userHandle(ANA);
        expect((await call('POST', '/git/branches', { name: `users/${ana}/mine` })).status).toBe(201);
        expect((await as(BIA)('PUT', '/git/current-branch', { branch: `users/${ana}/mine` })).status).toBe(200);
        const bia = await mcp(BIA);

        const read = await bia.tool('get_flow', { flowId: orders });
        expect(read.isError).toBeFalsy();
        for (const [name, args] of [
            ['save_draft', { flowId: orders, yaml: labelled('Bia'), expectedRevision: read.body.revision }],
            ['create_folder', { projectId, name: 'Imports' }],
            ['save_script', { projectId, path: 'lib/tax', content: 'export const rate = 0.2;\n' }],
        ] as const) {
            const refused = await bia.tool(name, args);
            expect({ name, isError: refused.isError, error: refused.body.error }).toEqual({
                name,
                isError: true,
                error: {
                    code: 'conflict',
                    message: `Your current branch cannot be edited (the branch users/${ana}/mine is ${ana}'s: only its owner changes it): pick or create a branch of your own in the editor, then try again.`,
                },
            });
        }

        await setMode('pull-request');
        expect((await as(BIA)('PUT', '/git/current-branch', { branch: 'dev' })).status).toBe(200);
        const onDev = await bia.tool('get_flow', { flowId: orders });
        const refused = await bia.tool('save_draft', { flowId: orders, yaml: labelled('Bia'), expectedRevision: onDev.body.revision });
        expect(refused.body.error.message).toBe(
            'Your current branch cannot be edited (the branch dev only takes pull requests): pick or create a branch of your own in the editor, then try again.',
        );
        expect((await bia.tool('test_run', { flowId: orders, timeoutS: 0 })).body.error).toBeUndefined();

        expect((await as(BIA)('POST', '/git/branches', { name: `users/${await userHandle(BIA)}/fix` })).status).toBe(201);
        const onBranch = await bia.tool('get_flow', { flowId: orders });
        const saved = await bia.tool('save_draft', { flowId: orders, yaml: labelled('Fixed'), expectedRevision: onBranch.body.revision });
        expect(saved.isError).toBeFalsy();
        expect(
            (await as(BIA)('GET', `/flows/${orders}/draft`)).body.flow.nodes.find((n: { type: string }) => n.type === 'start').label,
        ).toBe('Fixed');
    });
});
