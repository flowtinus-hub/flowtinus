import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoFlowToYaml, type FlowFile, type FlowFileNode } from '@flowtinus/core';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

type Version = { id: string; number: number };

type Flows = Record<string, { id: string; nodes?: Omit<FlowFileNode, 'position'>[]; start?: Record<string, unknown>; deployed?: boolean }>;

describe("the emergency rollback's checks: the tree with the old version swapped in, blocking only on what is new", () => {
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
        await call('POST', '/projects', { name: 'Sales' });
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);

        const handle = workspaceHandleOf(id);
        const base = Object.fromEntries(
            git(repo, 'ls-tree', '-r', '--name-only', 'dev')
                .split('\n')
                .filter(Boolean)
                .map(file => [file, Bun.spawnSync(['git', 'show', `dev:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString()]),
        );
        const scriptRef = (path: string) => `@w/${handle}/sales/scripts/${path}`;
        const fileOf = (name: string, flow: Flows[string]): string => {
            const middle = (flow.nodes ?? [{ id: 'log', type: 'log', config: { message: name } }]).map((n, i) => ({
                ...n,
                position: { x: 160 * (i + 1), y: 0 },
            }));
            const nodes = [
                { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: flow.start ?? {} },
                ...middle,
                { id: 'end', type: 'end', position: { x: 160 * (middle.length + 1), y: 0 }, config: {} },
            ];
            const file: FlowFile = {
                version: 1,
                id: flow.id,
                name,
                nodes,
                edges: nodes.slice(1).map((n, i) => ({ source: nodes[i]!.id, sourcePort: 'out-0', target: n.id, targetPort: 'in-0' })),
            };
            return repoFlowToYaml(file, { deployed: flow.deployed ?? true });
        };
        // the whole of the project's flows and scripts as git has them after this commit, reconciled
        const push = async (flows: Flows, scripts: Record<string, string> = {}) => {
            const files = { ...base };
            for (const [name, flow] of Object.entries(flows)) {
                files[`${handle}/projects/Sales/flows/${name}.flow.yaml`] = fileOf(name, flow);
            }
            for (const [path, content] of Object.entries(scripts)) {
                files[`${handle}/projects/Sales/scripts/${path}.ts`] = content;
            }
            commitFiles(repo, 'dev', files, 'From git');
            const reconciled = (await call('POST', '/git/reconcile')).body;
            expect(reconciled.outcome).toBe('applied');
        };
        const versions = async (flowId: string): Promise<Version[]> => (await call('GET', `/flows/${flowId}/deployments`)).body.versions;
        const version = async (flowId: string, number: number) => (await versions(flowId)).find(v => v.number === number)!;
        const check = async (flowId: string, to: Version) =>
            (await call('GET', `/flows/${flowId}/versions/${to.id}/emergency-rollback`)).body as { errors: string[]; warnings: string[] };
        const rollBack = (flowId: string, to: Version) => call('POST', `/flows/${flowId}/versions/${to.id}/emergency-rollback`);
        return { call, handle, scriptRef, push, version, check, rollBack };
    }

    const ids = () => ({
        orders: crypto.randomUUID(),
        billing: crypto.randomUUID(),
        caller: crypto.randomUUID(),
        router: crypto.randomUUID(),
    });

    const callTo = (flowId: string) => ({ id: 'call', type: 'flow', config: { flowId } });

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-emergency-rollback-checks-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('blocks on a called flow or a script that is no longer in the workspace', async () => {
        const { push, scriptRef, version, check, rollBack } = await workspace();
        const id = ids();
        const lib = { lib: 'export function fn() { return 1; }\n' };
        const old = [callTo(id.billing), { id: 'fn', type: 'script', config: { function: scriptRef('lib#fn') } }];
        await push({ Orders: { id: id.orders, nodes: old }, Billing: { id: id.billing } }, lib);
        await push(
            { Orders: { id: id.orders, nodes: [{ id: 'log', type: 'log', config: { message: 'v2' } }] }, Billing: { id: id.billing } },
            lib,
        );
        await push({ Orders: { id: id.orders, nodes: [{ id: 'log', type: 'log', config: { message: 'v2' } }] } });
        const v1 = await version(id.orders, 1);

        const { errors } = await check(id.orders, v1);
        expect(errors).toEqual([
            `Node "call" calls the flow "${id.billing}", which is not in the workspace.`,
            `Node "fn" uses the script "${scriptRef('lib')}", which is not in the workspace.`,
        ]);
        const refused = await rollBack(id.orders, v1);
        expect([refused.status, refused.body.error.message]).toEqual([400, errors.join(' ')]);
    });

    test('blocks on a called flow not deployed here, unless the running version calls it too', async () => {
        const { push, version, check, rollBack } = await workspace();
        const id = ids();
        await push({ Orders: { id: id.orders, nodes: [callTo(id.billing)] }, Billing: { id: id.billing } });
        await push({ Orders: { id: id.orders }, Billing: { id: id.billing, deployed: false } });
        const v1 = await version(id.orders, 1);

        expect((await check(id.orders, v1)).errors).toEqual(['Node "call" calls "Billing", which is not deployed here.']);
        expect((await rollBack(id.orders, v1)).status).toBe(400);

        // the running version calls it too: rolling back makes nothing worse
        await push({
            Orders: { id: id.orders, nodes: [callTo(id.billing), { id: 'log', type: 'log', config: { message: 'v3' } }] },
            Billing: { id: id.billing, deployed: false },
        });
        expect((await check(id.orders, v1)).errors).toEqual([]);
        expect((await rollBack(id.orders, v1)).status).toBe(200);
    });

    test("blocks on the Start's input type gone from its script, unless the running version's is gone too", async () => {
        const { push, scriptRef, version, check, rollBack } = await workspace();
        const id = ids();
        const typed = (name: string) => ({ acceptsInput: true, inputType: scriptRef(`types#${name}`) });
        await push(
            { Orders: { id: id.orders, start: typed('Order') } },
            { types: 'export type Order = { id: number };\nexport type Item = { sku: string };\n' },
        );
        await push({ Orders: { id: id.orders, start: typed('Item') } }, { types: 'export type Item = { sku: string };\n' });
        const v1 = await version(id.orders, 1);

        expect((await check(id.orders, v1)).errors).toEqual([
            `The Start's input type Order no longer exists in the script ${scriptRef('types')}.`,
        ]);
        expect((await rollBack(id.orders, v1)).status).toBe(400);

        await push({ Orders: { id: id.orders, start: typed('Gone') } }, { types: 'export type Item = { sku: string };\n' });
        expect((await check(id.orders, v1)).errors).toEqual([]);
        expect((await rollBack(id.orders, v1)).status).toBe(200);
    });

    test('a call by expression does not block, whatever the flows it may call', async () => {
        const { push, version, check, rollBack } = await workspace();
        const id = ids();
        const byExpression = {
            id: 'call',
            type: 'flow',
            config: { flowId: '$dynamic', flowPath: { value: "'Bill' + 'ing'", expression: true } },
        };
        await push({ Orders: { id: id.orders, nodes: [byExpression] }, Billing: { id: id.billing } });
        await push({ Orders: { id: id.orders }, Billing: { id: id.billing, deployed: false } });
        const v1 = await version(id.orders, 1);

        expect((await check(id.orders, v1)).errors).toEqual([]);
        expect((await rollBack(id.orders, v1)).status).toBe(200);
    });

    test("warns on a secret with no value, and on a Start input type other than git's, naming the deployed callers", async () => {
        const { push, scriptRef, version, check, rollBack } = await workspace();
        const id = ids();
        const types = { types: 'export type Order = { id: number };\nexport type Item = { sku: string };\n' };
        const byExpression = {
            id: 'call',
            type: 'flow',
            config: { flowId: '$dynamic', flowPath: { value: "'Ord' + 'ers'", expression: true } },
        };
        const callers = {
            Caller: { id: id.caller, nodes: [callTo(id.orders)] },
            Router: { id: id.router, nodes: [byExpression] },
        };
        const old = {
            id: id.orders,
            start: { acceptsInput: true, inputType: scriptRef('types#Item') },
            nodes: [{ id: 'log', type: 'log', config: { message: '$SECRETS.apiKey' } }],
        };
        await push({ Orders: old, ...callers }, types);
        await push({ Orders: { id: id.orders, start: { acceptsInput: true, inputType: scriptRef('types#Order') } }, ...callers }, types);
        const v1 = await version(id.orders, 1);

        const { errors, warnings } = await check(id.orders, v1);
        expect(errors).toEqual([]);
        expect(warnings).toEqual([
            'The secret "apiKey" has no value on this server.',
            "The Start's input type of v1 (Item) differs from git's v2 (Order): callers may send an input v1 does not accept. The deployed flows that call it: Caller. Flows call others by expression in this project (Router): they may call it too.",
        ]);
        expect((await rollBack(id.orders, v1)).status).toBe(200);
    });
});
