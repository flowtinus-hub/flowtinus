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

type Mode = 'direct' | 'pull-request' | 'protected';

describe("an environment's mode decides whether its server changes the tree", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace(mode: Mode) {
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
        const orders = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
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
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);

        const show = (ref: string, file: string) =>
            Bun.spawnSync(['git', 'show', `${ref}:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        if (mode !== 'direct') {
            const topology = show('flowtinus/config', 'topology.yaml');
            expect(topology).toContain('mode: direct');
            commitFiles(
                repo,
                'flowtinus/config',
                { 'topology.yaml': topology.replace('mode: direct', `mode: ${mode}`) },
                `DEV takes ${mode}`,
            );
            expect((await call('POST', '/git/reconcile')).status).toBe(200);
        }
        const tip = () => git(repo, 'rev-parse', 'dev');
        return { id, call, repo, projectId, orders, show, tip };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-modes-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-git-modes', '{default}', 1, 'test')`);
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    const REFUSED = 'DEV only takes pull requests: edit in git.';

    // a pull-request environment's branch refuses drafts too, and offers Create branch: git-pull-request-api.test.ts
    for (const mode of ['protected'] as const) {
        test(`${mode}: the Commit and the tree's actions are refused; drafts, test runs and the reconcile work`, async () => {
            const { call, repo, projectId, orders, show, tip } = await newWorkspace(mode);
            const before = tip();
            expect((await call('GET', '/git/status')).body.mode).toBe(mode);
            expect((await call('GET', `/flows/${orders}/deployments`)).body.git).toEqual({ branch: 'dev', mode });

            const { flow, revision } = (await call('GET', `/flows/${orders}/draft`)).body;
            const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label: 'Begin' } : n));
            expect((await call('PUT', `/flows/${orders}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
            const scripts = `/projects/${projectId}/scripts`;
            const saved = await call('PUT', `${scripts}/content`, { path: 'lib/prices', content: 'export const a = 2;', revision: 0 });
            expect(saved.status).toBe(200);
            expect((await call('POST', `/flows/${orders}/runs`, { mode: 'validation' })).status).toBe(202);

            for (const [method, path, body] of [
                ['POST', `/flows/${orders}/deploy`, { message: 'Begin' }],
                ['POST', `/flows/${orders}/undeploy`, undefined],
                ['POST', `/projects/${projectId}/folders`, { name: 'Imports' }],
                ['PATCH', `/flows/${orders}`, { name: 'Sales orders' }],
                ['POST', `${scripts}/commit`, { paths: ['lib/prices'] }],
                ['POST', `${scripts}/move`, { from: 'lib', to: 'shared' }],
                ['POST', '/projects', { name: 'Billing' }],
            ] as const) {
                const refused = await call(method, path, body);
                expect({ path, status: refused.status, message: refused.body.error?.message }).toEqual({
                    path,
                    status: 409,
                    message: REFUSED,
                });
            }
            expect(tip()).toBe(before);
            expect((await call('GET', `/flows/${orders}`)).body.name).toBe('Orders');

            // a commit made in git still arrives
            const files = Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', 'dev')
                    .split('\n')
                    .map(file => [file, show('dev', file)]),
            );
            const projectFile = Object.keys(files).find(file => file.endsWith('/projects/Sales/project.yaml'))!;
            commitFiles(
                repo,
                'dev',
                { ...files, [projectFile]: `${files[projectFile]}description: From a pull request\n` },
                'Merge pull request',
            );
            expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');
            expect((await call('GET', `/projects/${projectId}`)).body.description).toBe('From a pull request');
        });
    }

    test('pull-request: the MCP refuses a change, saying to pick or create a branch; run_for_real of a draft runs, with the notice', async () => {
        const { id, projectId, orders } = await newWorkspace('pull-request');
        const { token } = newApiToken();
        await insertApiToken(db, { userId: ANA, name: 'test', token, scopes: API_SCOPES });
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
                fetch: (url, init) => Promise.resolve(app.request(String(url), init as RequestInit)),
            }),
        );
        const tool = async (name: string, args: Record<string, unknown>) =>
            (await client.callTool({ name, arguments: { workspace: slugOf(id), ...args } })) as {
                isError?: boolean;
                content: { text: string }[];
            };

        const folder = await tool('create_folder', { projectId, name: 'Imports' });
        expect(folder.isError).toBe(true);
        expect(folder.content[0]!.text).toContain('pick or create a branch of your own in the editor');

        const real = await tool('run_for_real', { flowId: orders, userApproval: 'run Orders for real', timeoutS: 0 });
        expect(real.isError).toBeFalsy();
        expect(JSON.parse(real.content[0]!.text).notice).toBe(
            'The draft is not on dev: this environment only takes pull requests, so what runs is a draft no commit holds.',
        );
        await client.close();
    });

    test('direct: a tree change waits in the working copy, a Commit takes it', async () => {
        const { call, projectId, tip } = await newWorkspace('direct');
        const before = tip();
        expect((await call('POST', `/projects/${projectId}/folders`, { name: 'Imports' })).status).toBe(201);
        expect(tip()).toBe(before);
        expect((await commitAll(call, 'Create folder Imports')).status).toBe(200);
        expect(tip()).not.toBe(before);
        expect((await call('GET', '/git/status')).body.mode).toBe('direct');
    });
});
