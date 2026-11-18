import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

type Node = { id: string; type: string; label?: string; position: { x: number; y: number }; config: Record<string, unknown> };

describe('the deployed script set: a deployed run takes what is committed, a test run what is being edited', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace(options: { git?: boolean } = {}) {
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
        if (options.git !== false) {
            await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
            await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
            expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
            expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        }

        const script = async (path: string, content: string) =>
            expect((await call('POST', `/projects/${projectId}/scripts`, { kind: 'script', path, content })).status).toBe(201);
        const save = async (path: string, content: string) => {
            const { revision } = (await call('GET', `/projects/${projectId}/scripts/content?path=${encodeURIComponent(path)}`)).body;
            expect((await call('PUT', `/projects/${projectId}/scripts/content`, { path, content, revision })).status).toBe(200);
        };
        const editing = async (path: string) =>
            (await call('GET', `/projects/${projectId}/scripts/content?path=${encodeURIComponent(path)}`)).body.content as string;
        // a flow whose TypeScript component imports `imports`, and that calls the flows in `calls`
        const flow = async (name: string, imports: string, calls: string[] = []) => {
            const flowId = (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
            await draft(flowId, imports, calls);
            return flowId;
        };
        const draft = async (flowId: string, imports: string, calls: string[] = []) => {
            const { flow, revision } = (await call('GET', `/flows/${flowId}/draft`)).body;
            const steps: Node[] = [
                {
                    id: 'ts',
                    type: 'typescript',
                    position: { x: 160, y: 0 },
                    config: { code: `import { value } from '@myproject/scripts/${imports}';` },
                },
                ...calls.map((to, i) => ({ id: `call${i}`, type: 'flow', position: { x: 160, y: 80 * (i + 1) }, config: { flowId: to } })),
            ];
            const ends = flow.nodes.filter((n: Node) => n.type === 'start' || n.type === 'end');
            const [start, end] = ['start', 'end'].map(type => ends.find((n: Node) => n.type === type)!.id);
            const edges = steps.flatMap(s => [
                { source: start, sourcePort: 'out-0', target: s.id, targetPort: 'in-0' },
                { source: s.id, sourcePort: 'out-0', target: end, targetPort: 'in-0' },
            ]);
            const saved = await call('PUT', `/flows/${flowId}/draft`, { revision, flow: { ...flow, nodes: [...ends, ...steps], edges } });
            expect(saved.status).toBe(200);
        };
        const deploy = async (flowId: string) => expect((await call('POST', `/flows/${flowId}/deploy`)).status).toBe(200);
        const scriptsOf = async (runId: string) => {
            const [run] = await db.query<{ scripts: Record<string, string> }>(
                'SELECT scripts FROM runs WHERE id = $1 UNION ALL SELECT scripts FROM test_runs WHERE id = $1',
                [runId],
            );
            const blobs = await db.query<{ hash: string; content: string }>(
                'SELECT hash, content FROM script_blobs WHERE workspace_id = $1',
                [id],
            );
            return Object.fromEntries(
                Object.entries(run!.scripts).map(([path, hash]) => [path, blobs.find(b => b.hash === hash)!.content]),
            );
        };
        const testRun = async (flowId: string) => {
            const started = await call('POST', `/flows/${flowId}/runs`, { mode: 'validation' });
            expect(started.status).toBe(202);
            return scriptsOf(started.body.id);
        };
        const webhookOf = async (flowId: string) => {
            const { webhook, token } = (await call('POST', `/flows/${flowId}/webhooks`, { name: 'Shop' })).body;
            return async () => {
                // the worker seen just now: a long run of the suite would leave the one inserted at the start lost
                await db.query('UPDATE supervisors SET last_seen = now()');
                const response = await app.request(`/wh/${webhook.id}`, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
                expect(response.status).toBe(202);
                return scriptsOf(((await response.json()) as { runId: string }).runId);
            };
        };
        const scriptPath = (path: string) => `${slugOf(id)}/projects/Sales/scripts/${path}.ts`;
        const onBranch = (): Record<string, string> =>
            Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', 'dev')
                    .split('\n')
                    .map(path => [path, Bun.spawnSync(['git', 'show', `dev:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString()]),
            );
        return { call, repo, script, save, editing, flow, draft, deploy, testRun, webhookOf, scriptPath, onBranch };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-scripts-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-git-scripts', '{default}', 1, 'test')`);
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a script only saved reaches test runs, not deployed runs; a commit that changes it reaches deployed runs', async () => {
        const { call, repo, script, save, editing, flow, deploy, testRun, webhookOf, scriptPath, onBranch } = await newWorkspace();
        await script('lib/prices', 'export const value = 1;');
        const orders = await flow('Orders', 'lib/prices');
        await deploy(orders);
        const webhook = await webhookOf(orders);
        const commits = git(repo, 'rev-list', '--count', 'dev');

        await save('lib/prices', 'export const value = 2;');
        expect(git(repo, 'rev-list', '--count', 'dev')).toBe(commits);
        expect(onBranch()[scriptPath('lib/prices')]).toBe('export const value = 1;');
        expect(await webhook()).toEqual({ 'lib/prices': 'export const value = 1;' });
        expect(await testRun(orders)).toEqual({ 'lib/prices': 'export const value = 2;' });

        commitFiles(repo, 'dev', { ...onBranch(), [scriptPath('lib/prices')]: 'export const value = 3;' }, 'Prices from git');
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');
        expect(await webhook()).toEqual({ 'lib/prices': 'export const value = 3;' });
        // the same line changed on both sides: the edit is kept, in conflict
        expect(await editing('lib/prices')).toBe('export const value = 2;');
        expect(await testRun(orders)).toEqual({ 'lib/prices': 'export const value = 2;' });
    });

    test('a commit that leaves a script as it was keeps its editing copy', async () => {
        const { call, repo, script, save, editing, flow, deploy, webhookOf, scriptPath, onBranch } = await newWorkspace();
        await script('lib/prices', 'export const value = 1;');
        await script('lib/other', 'export const value = 10;');
        const orders = await flow('Orders', 'lib/prices');
        await deploy(orders);
        const webhook = await webhookOf(orders);

        await save('lib/prices', 'export const value = 2;');
        commitFiles(repo, 'dev', { ...onBranch(), [scriptPath('lib/other')]: 'export const value = 11;' }, 'Other from git');
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');
        expect(await editing('lib/prices')).toBe('export const value = 2;');
        expect(await editing('lib/other')).toBe('export const value = 11;');
        expect(await webhook()).toEqual({ 'lib/prices': 'export const value = 1;' });

        // the app's own commits leave it too: a rename, a deploy
        expect((await call('PATCH', `/flows/${orders}`, { name: 'Sales orders' })).status).toBe(200);
        expect(await editing('lib/prices')).toBe('export const value = 2;');
        expect(onBranch()[scriptPath('lib/prices')]).toBe('export const value = 1;');
    });

    test('a deployed run takes the deployed set through the scripts it imports and the flows it calls, with their deployed versions', async () => {
        const { script, save, flow, draft, deploy, testRun, webhookOf } = await newWorkspace();
        await script('lib/math', 'export const two = 2;');
        await script('lib/prices', "import { two } from '@myproject/scripts/lib/math';\nexport const value = two;");
        await script('lib/tax', 'export const value = 0.1;');
        await script('lib/fees', 'export const value = 5;');
        const tax = await flow('Tax', 'lib/tax');
        await deploy(tax);
        const orders = await flow('Orders', 'lib/prices', [tax]);
        await deploy(orders);
        const webhook = await webhookOf(orders);

        await save('lib/math', 'export const two = 3;');
        await save('lib/tax', 'export const value = 0.2;');
        await draft(tax, 'lib/fees');

        expect(await webhook()).toEqual({
            'lib/math': 'export const two = 2;',
            'lib/prices': "import { two } from '@myproject/scripts/lib/math';\nexport const value = two;",
            'lib/tax': 'export const value = 0.1;',
        });
        expect(await testRun(orders)).toEqual({
            'lib/math': 'export const two = 3;',
            'lib/prices': "import { two } from '@myproject/scripts/lib/math';\nexport const value = two;",
            'lib/fees': 'export const value = 5;',
        });
    });

    test('with git off, a deployed run takes the scripts as saved, as before', async () => {
        const { script, save, flow, deploy, testRun, webhookOf } = await newWorkspace({ git: false });
        await script('lib/prices', 'export const value = 1;');
        const orders = await flow('Orders', 'lib/prices');
        await deploy(orders);
        const webhook = await webhookOf(orders);

        await save('lib/prices', 'export const value = 2;');
        expect(await webhook()).toEqual({ 'lib/prices': 'export const value = 2;' });
        expect(await testRun(orders)).toEqual({ 'lib/prices': 'export const value = 2;' });
    });

    test('removing git forgets the deployed set: deployed runs take the scripts as saved again', async () => {
        const { call, script, save, flow, deploy, webhookOf } = await newWorkspace();
        await script('lib/prices', 'export const value = 1;');
        const orders = await flow('Orders', 'lib/prices');
        await deploy(orders);
        const webhook = await webhookOf(orders);
        await save('lib/prices', 'export const value = 2;');
        expect(await webhook()).toEqual({ 'lib/prices': 'export const value = 1;' });

        expect((await call('DELETE', '/git')).status).toBe(200);
        expect(await webhook()).toEqual({ 'lib/prices': 'export const value = 2;' });
    });
});
