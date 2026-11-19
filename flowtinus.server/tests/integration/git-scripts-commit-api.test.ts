import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ANA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { API_SCOPES, insertApiToken, newApiToken } from '#features/api-tokens/api-tokens';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

type Script = { path: string; changed?: boolean; conflict?: string };

describe('scripts reach the branch through a Commit', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace() {
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
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);

        const scripts = `/projects/${projectId}/scripts`;
        const create = async (path: string, content: string) => {
            expect((await call('POST', scripts, { kind: 'script', path, content })).status).toBe(201);
            expect((await commitAll(call, `Create script ${path}`)).status).toBe(200);
        };
        const editing = async (path: string) => (await call('GET', `${scripts}/content?path=${encodeURIComponent(path)}`)).body;
        const save = async (path: string, content: string) => {
            const { revision } = await editing(path);
            expect((await call('PUT', `${scripts}/content`, { path, content, revision })).status).toBe(200);
        };
        const listed = async () => (await call('GET', scripts)).body.scripts as Script[];
        const flow = async (name: string, imports: string) => {
            const flowId = (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
            const { flow: file, revision } = (await call('GET', `/flows/${flowId}/draft`)).body;
            const nodes = [
                ...file.nodes,
                {
                    id: 'ts',
                    type: 'typescript',
                    position: { x: 160, y: 0 },
                    config: { code: `import { value } from '@myproject/scripts/${imports}';` },
                },
            ];
            expect((await call('PUT', `/flows/${flowId}/draft`, { revision, flow: { ...file, nodes } })).status).toBe(200);
            return flowId;
        };
        const show = (file: string) => Bun.spawnSync(['git', 'show', `dev:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        const scriptFile = (path: string) => `${slugOf(id)}/projects/Sales/scripts/${path}.ts`;
        const flowFile = (name: string) => `${slugOf(id)}/projects/Sales/flows/${name}.flow.yaml`;
        const tree = () => git(repo, 'ls-tree', '-r', '--name-only', 'dev').split('\n');
        const onBranch = (): Record<string, string> => Object.fromEntries(tree().map(file => [file, show(file)]));
        const tip = () => git(repo, 'rev-parse', 'dev');
        const lastMessage = () => git(repo, 'log', '-1', '--format=%s', 'dev');
        return {
            id,
            call,
            repo,
            projectId,
            scripts,
            create,
            editing,
            save,
            listed,
            flow,
            show,
            scriptFile,
            flowFile,
            tree,
            onBranch,
            tip,
            lastMessage,
        };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-scripts-commit-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-git-scripts-commit', '{default}', 1, 'test')`);
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("the scripts page's Commit takes the changed scripts to the branch, and deployed runs then import them", async () => {
        const { id, call, scripts, create, save, listed, flow, show, scriptFile, tip, lastMessage } = await newWorkspace();
        await create('lib/prices', 'export const value = 1;');
        await create('lib/other', 'export const value = 10;');
        expect(await listed()).toEqual([
            expect.objectContaining({ path: 'lib/other', changed: false }),
            expect.objectContaining({ path: 'lib/prices', changed: false }),
        ]);
        const orders = await flow('Orders', 'lib/prices');
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        const { webhook, token } = (await call('POST', `/flows/${orders}/webhooks`, { name: 'Shop' })).body;
        const deployedRun = async () => {
            // the worker seen just now: a long run of the suite would leave the one inserted at the start lost
            await db.query('UPDATE supervisors SET last_seen = now()');
            const response = await app.request(`/wh/${webhook.id}`, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
            const [run] = await db.query<{ scripts: Record<string, string> }>('SELECT scripts FROM runs WHERE id = $1', [
                ((await response.json()) as { runId: string }).runId,
            ]);
            const [blob] = await db.query<{ content: string }>('SELECT content FROM script_blobs WHERE workspace_id = $1 AND hash = $2', [
                id,
                run!.scripts['lib/prices'],
            ]);
            return blob!.content;
        };

        const before = tip();
        await save('lib/prices', 'export const value = 2;');
        await save('lib/other', 'export const value = 20;');
        expect(tip()).toBe(before);
        expect((await listed()).map(s => [s.path, s.changed])).toEqual([
            ['lib/other', true],
            ['lib/prices', true],
        ]);
        expect(await deployedRun()).toBe('export const value = 1;');

        const committed = await call('POST', `${scripts}/commit`, { paths: ['lib/prices'], message: 'Raise the price' });
        expect(committed.status).toBe(200);
        expect(committed.body.commit).toBe(tip());
        expect(lastMessage()).toBe('Raise the price');
        expect(show(scriptFile('lib/prices'))).toBe('export const value = 2;');
        expect(show(scriptFile('lib/other'))).toBe('export const value = 10;');
        expect((await listed()).map(s => [s.path, s.changed])).toEqual([
            ['lib/other', true],
            ['lib/prices', false],
        ]);
        expect(await deployedRun()).toBe('export const value = 2;');

        const again = await call('POST', `${scripts}/commit`, { paths: ['lib/prices'] });
        expect(again.status).toBe(400);
        expect(again.body.error.message).toBe('Nothing to commit: the scripts are as committed.');
    });

    test("a flow's Commit takes the changed scripts it imports, directly or through another script, with it", async () => {
        const { call, create, save, flow, show, scriptFile, flowFile } = await newWorkspace();
        await create('lib/math', 'export const two = 2;');
        await create('lib/prices', "import { two } from '@myproject/scripts/lib/math';\nexport const value = two;");
        await create('lib/other', 'export const value = 10;');
        const orders = await flow('Orders', 'lib/prices');
        await save('lib/math', 'export const two = 3;');
        await save('lib/prices', "import { two } from '@myproject/scripts/lib/math';\nexport const value = two + 1;");
        await save('lib/other', 'export const value = 20;');

        expect((await call('GET', `/flows/${orders}/deployments`)).body.changedScripts).toEqual(['lib/math', 'lib/prices']);
        const committed = await call('POST', `/flows/${orders}/deploy`, { scripts: ['lib/prices'] });
        expect(committed.status).toBe(200);
        expect(show(flowFile('Orders'))).toContain('@myproject/scripts/lib/prices');
        expect(show(scriptFile('lib/prices'))).toContain('two + 1');
        expect(show(scriptFile('lib/math'))).toBe('export const two = 3;');
        expect(show(scriptFile('lib/other'))).toBe('export const value = 10;');
        expect(committed.body.changedScripts).toEqual([]);
    });

    test('renaming a script rewrites its callers and their drafts; one Commit takes them all', async () => {
        const { call, scripts, create, save, editing, flow, show, scriptFile, flowFile, tree, lastMessage } = await newWorkspace();
        await create('lib/prices', 'export const value = 1;');
        await create('lib/total', "import { value } from '@myproject/scripts/lib/prices';\nexport const total = value;");
        const orders = await flow('Orders', 'lib/prices');
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        await save('lib/prices', 'export const value = 2;');
        const commits = tree().length;

        expect((await call('POST', `${scripts}/move`, { from: 'lib/prices', to: 'shared/prices' })).status).toBe(200);
        expect(tree()).toContain(scriptFile('lib/prices'));
        expect((await commitAll(call, 'Move script lib/prices to shared/prices')).status).toBe(200);
        expect(lastMessage()).toBe('Move script lib/prices to shared/prices');
        expect(tree()).toHaveLength(commits);
        expect(tree()).not.toContain(scriptFile('lib/prices'));
        expect(show(scriptFile('shared/prices'))).toBe('export const value = 2;');
        expect(show(scriptFile('lib/total'))).toContain("from '@myproject/scripts/shared/prices'");
        expect(show(flowFile('Orders'))).toContain('@myproject/scripts/shared/prices');

        expect((await editing('shared/prices')).content).toBe('export const value = 2;');
        expect((await editing('lib/total')).content).toContain("from '@myproject/scripts/shared/prices'");
        const draft = (await call('GET', `/flows/${orders}/draft`)).body;
        expect(JSON.stringify(draft.flow)).toContain('@myproject/scripts/shared/prices');
        const deployments = (await call('GET', `/flows/${orders}/deployments`)).body;
        expect(deployments.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
        expect(deployments.deployed.versionId).toBe(deployments.versions[0].id);
        // several commits, each pushed and reconciled: beside the other suites it outlasts 30 s
    }, 90_000);

    test("a script's editing copy is merged three ways when a commit changes the script; a conflict is marked until discarded", async () => {
        const { call, repo, scripts, create, save, editing, listed, scriptFile, onBranch } = await newWorkspace();
        await create('lib/prices', 'export const a = 1;\nexport const b = 1;\nexport const c = 1;\n');
        await save('lib/prices', 'export const a = 2;\nexport const b = 1;\nexport const c = 1;\n');
        commitFiles(repo, 'dev', {
            ...onBranch(),
            [scriptFile('lib/prices')]: 'export const a = 1;\nexport const b = 1;\nexport const c = 3;\n',
        });
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');
        expect((await editing('lib/prices')).content).toBe('export const a = 2;\nexport const b = 1;\nexport const c = 3;\n');
        expect((await listed())[0]).toMatchObject({ changed: true });
        expect((await listed())[0]!.conflict).toBeUndefined();

        await save('lib/prices', 'export const a = 2;\nexport const b = 2;\nexport const c = 3;\n');
        const theirs = commitFiles(repo, 'dev', {
            ...onBranch(),
            [scriptFile('lib/prices')]: 'export const a = 1;\nexport const b = 9;\nexport const c = 3;\n',
        });
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');
        expect((await editing('lib/prices')).content).toBe('export const a = 2;\nexport const b = 2;\nexport const c = 3;\n');
        expect((await listed())[0]).toMatchObject({ conflict: theirs });
        const refused = await call('POST', `${scripts}/commit`, { paths: ['lib/prices'] });
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toBe(
            `The script lib/prices conflicts with git's commit ${theirs.slice(0, 7)}: discard its changes first.`,
        );

        expect((await call('POST', `${scripts}/discard`, { path: 'lib/prices' })).status).toBe(200);
        expect((await editing('lib/prices')).content).toBe('export const a = 1;\nexport const b = 9;\nexport const c = 3;\n');
        expect((await listed())[0]).toMatchObject({ changed: false });
        expect((await listed())[0]!.conflict).toBeUndefined();
    });

    test('save_script in the MCP writes only the editing copy', async () => {
        const { id, projectId, create, editing, scriptFile, show, tip } = await newWorkspace();
        await create('lib/prices', 'export const value = 1;');
        const before = tip();
        const { token } = newApiToken();
        await insertApiToken(db, { userId: ANA, name: 'test', token, scopes: API_SCOPES });
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
                fetch: (url, init) => Promise.resolve(app.request(String(url), init as RequestInit)),
            }),
        );
        const saved = (await client.callTool({
            name: 'save_script',
            arguments: { workspace: slugOf(id), projectId, path: 'lib/prices', content: 'export const value = 5;', expectedRevision: 0 },
        })) as { isError?: boolean };
        expect(saved.isError).toBeFalsy();
        expect((await editing('lib/prices')).content).toBe('export const value = 5;');
        expect(tip()).toBe(before);
        expect(show(scriptFile('lib/prices'))).toBe('export const value = 1;');
        await client.close();
    });
});
