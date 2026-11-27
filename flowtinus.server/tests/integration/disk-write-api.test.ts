import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GITATTRIBUTES, projectToYaml, repoFlowFromYaml, repoFlowToYaml, workspaceToYaml, type FlowFile } from '@flowtinus/core';
import { git } from '../helpers/git-repos';
import { ANA } from '../helpers/workspaces';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { API_SCOPES, insertApiToken, newApiToken } from '#features/api-tokens/api-tokens';
import { reconcileDisk } from '#features/git/disk-reconcile';
import { gitOptions, type GitOptions } from '#features/git/git-config';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

const at = (x: number) => ({ x, y: 0 });

const twoLogs = (id: string, first: string, second: string): FlowFile => ({
    version: 1,
    id,
    name: 'Orders',
    nodes: [
        { id: 'start', type: 'start', position: at(0), config: {} },
        { id: 'first', type: 'log', position: at(100), config: { message: first } },
        { id: 'second', type: 'log', position: at(200), config: { message: second } },
        { id: 'end', type: 'end', position: at(900), config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'first', targetPort: 'in-0' },
        { source: 'first', sourcePort: 'out-0', target: 'second', targetPort: 'in-0' },
        { source: 'second', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

const messages = (flow: FlowFile) => flow.nodes.filter(n => n.type === 'log').map(n => n.config.message);

describe('on a local server the editor and the MCP write to disk', () => {
    let db: Database;
    let dir: string;
    let repo: string;
    let options: GitOptions;
    let app: ReturnType<typeof createApp>;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);
    const ids = { sales: crypto.randomUUID(), orders: crypto.randomUUID() };
    const paths = {
        project: 'sales/projects/Sales/project.yaml',
        orders: 'sales/projects/Sales/flows/Orders.flow.yaml',
        prices: 'sales/projects/Sales/scripts/lib/prices.ts',
    };

    const write = (files: Record<string, string>) => {
        for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(repo, path)), { recursive: true });
            writeFileSync(join(repo, path), text);
        }
    };
    const read = (path: string) => readFileSync(join(repo, path), 'utf8');
    const onDisk = (path: string) => existsSync(join(repo, path));
    const diskFlow = (path = paths.orders) => {
        const parsed = repoFlowFromYaml(read(path), 'Orders');
        if (!parsed.ok) {
            throw new Error(parsed.errors.join(' '));
        }
        return parsed.value.flow;
    };

    const call = async (method: string, path: string, body?: unknown) => {
        const response = await app.request(path, {
            method,
            headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as any };
    };
    const draft = async () => (await call('GET', `/w/sales/flows/${ids.orders}/draft`)).body as { flow: FlowFile; revision: string };
    const versions = async () => (await call('GET', `/w/sales/flows/${ids.orders}/deployments`)).body.versions as unknown[];
    const workingCopy = async () => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM working_copy'))[0]!.n;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-disk-write-'));
        repo = join(dir, 'flows');
        mkdirSync(repo);
        git(repo, 'init', '--quiet', '--initial-branch=main');
        db = await openDatabase('memory://');
        await db.query('INSERT INTO users (id, name, email, is_admin) VALUES ($1, $2, $3, true)', [ANA, 'Ana', 'ana@example.com']);
        options = gitOptions('LOCAL', { clonesDir: join(dir, 'clones'), localRepo: repo });
        app = createApp(db, 'LOCAL', keyring, undefined, { git: options });
        write({
            '.gitattributes': GITATTRIBUTES,
            'sales/workspace.yaml': workspaceToYaml(),
            [paths.project]: projectToYaml({ id: ids.sales, description: 'Money in', icon: 'cart', color: 'green' }),
            [paths.orders]: repoFlowToYaml(twoLogs(ids.orders, 'one', 'two')),
            [paths.prices]: "export const price = 'v1';",
        });
        await reconcileDisk({ db, keyring, git: options });
    });

    afterEach(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("a save writes the flow's file in the canonical form and reconciles in the request, with no working copy", async () => {
        const { flow, revision } = await draft();
        expect(revision).toBe(new Bun.CryptoHasher('sha256').update(read(paths.orders)).digest('hex'));

        const saved = await call('PUT', `/w/sales/flows/${ids.orders}/draft`, { revision, flow: twoLogs(ids.orders, 'uno', 'two') });

        expect(saved.status).toBe(200);
        expect(read(paths.orders)).toBe(repoFlowToYaml(twoLogs(ids.orders, 'uno', 'two')));
        expect(saved.body.revision).toBe((await draft()).revision);
        expect(await versions()).toHaveLength(2);
        expect(await workingCopy()).toBe(0);
        expect(messages(flow)).toEqual(['one', 'two']);
    });

    test('a save over an edit made on disk since is merged three ways: a clean merge is written', async () => {
        const { revision } = await draft();
        write({ [paths.orders]: repoFlowToYaml(twoLogs(ids.orders, 'one', 'dos')) });

        const saved = await call('PUT', `/w/sales/flows/${ids.orders}/draft`, { revision, flow: twoLogs(ids.orders, 'uno', 'two') });

        expect(saved.status).toBe(200);
        expect(messages(diskFlow())).toEqual(['uno', 'dos']);
        const now = await draft();
        expect(messages(now.flow)).toEqual(['uno', 'dos']);
        expect(now.revision).not.toBe(saved.body.revision);
    });

    test('a conflict refuses the save and leaves the disk untouched', async () => {
        const { revision } = await draft();
        const theirs = repoFlowToYaml(twoLogs(ids.orders, 'eins', 'two'));
        write({ [paths.orders]: theirs });

        const saved = await call('PUT', `/w/sales/flows/${ids.orders}/draft`, { revision, flow: twoLogs(ids.orders, 'uno', 'two') });

        expect(saved.status).toBe(409);
        expect(saved.body.error.message).toContain('changed on disk');
        expect(read(paths.orders)).toBe(theirs);
    });

    test('tree changes write the files: a new flow, a rename that moves its file, a folder, a script; Deploy is off', async () => {
        const created = await call('POST', `/w/sales/projects/${ids.sales}/flows`, { name: 'Refunds', folderId: null });
        expect(created.status).toBe(201);
        expect(onDisk('sales/projects/Sales/flows/Refunds.flow.yaml')).toBe(true);

        const renamed = await call('PATCH', `/w/sales/flows/${ids.orders}`, { name: 'Sales orders' });
        expect(renamed.status).toBe(200);
        expect(onDisk(paths.orders)).toBe(false);
        expect(onDisk('sales/projects/Sales/flows/Sales orders.flow.yaml')).toBe(true);

        expect((await call('POST', `/w/sales/projects/${ids.sales}/folders`, { name: 'Daily', parentId: null })).status).toBe(201);
        expect(onDisk('sales/projects/Sales/flows/Daily/.gitkeep')).toBe(true);

        const script = await call('PUT', `/w/sales/projects/${ids.sales}/scripts/content`, {
            path: 'lib/prices',
            content: "export const price = 'v2';",
            revision: 0,
        });
        expect(script.status).toBe(200);
        expect(read(paths.prices)).toBe("export const price = 'v2';");
        expect(await workingCopy()).toBe(0);

        const deploy = await call('POST', `/w/sales/flows/${ids.orders}/deploy`, {});
        expect(deploy.status).toBe(409);
        expect(deploy.body.error.message).toContain('local server');
    });

    test("the MCP's save_draft writes to disk; get_flow's revision is the file's hash, a stale one refused", async () => {
        const { token } = newApiToken();
        await insertApiToken(db, { userId: ANA, name: 'test', token, scopes: API_SCOPES });
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
                fetch: (url, init) => Promise.resolve(app.request(String(url), init as RequestInit)),
            }),
        );
        const mcp = async (name: string, args: Record<string, unknown>) => {
            const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
            return { isError: result.isError, body: JSON.parse(result.content[0]!.text) };
        };

        const got = await mcp('get_flow', { flowId: ids.orders });
        expect(got.body.revision).toBe(new Bun.CryptoHasher('sha256').update(read(paths.orders)).digest('hex'));
        const yaml = got.body.yaml.replace('message: one', 'message: uno');

        const saved = await mcp('save_draft', { flowId: ids.orders, yaml, expectedRevision: got.body.revision });
        expect(saved.isError).toBeFalsy();
        expect(messages(diskFlow())).toEqual(['uno', 'two']);

        const stale = await mcp('save_draft', { flowId: ids.orders, yaml, expectedRevision: got.body.revision });
        expect(stale.isError).toBe(true);
        expect(stale.body.error).toMatchObject({ code: 'conflict', currentRevision: saved.body.revision });

        const created = await mcp('create_flow', { projectId: ids.sales, name: 'Refunds', yaml });
        expect(created.isError).toBeFalsy();
        expect(read('sales/projects/Sales/flows/Refunds.flow.yaml')).toContain('message: uno');
        await client.close();
    });

    test('the status gives the branch git has checked out, or the short sha when HEAD is detached', async () => {
        git(repo, '-c', 'user.name=Ana', '-c', 'user.email=ana@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'one');
        expect((await call('GET', '/w/sales/git/status')).body.disk.head).toEqual({
            branch: 'main',
            sha: git(repo, 'rev-parse', '--short', 'HEAD'),
        });

        git(repo, 'checkout', '--quiet', '--detach');
        expect((await call('GET', '/w/sales/git/status')).body.disk.head).toEqual({
            branch: null,
            sha: git(repo, 'rev-parse', '--short', 'HEAD'),
        });
    });
});
