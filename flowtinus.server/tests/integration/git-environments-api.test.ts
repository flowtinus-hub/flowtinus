import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoFlowFromYaml, repoFlowToYaml } from '@flowtinus/core';
import { ANA, insertMember, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

const TOPOLOGY = `environments:
  - env: PROD
    label: Production
    branch: main
    promotesTo: []
    mode: protected
  - env: DEV
    label: Development
    branch: dev
    promotesTo: [QA]
    mode: direct
  - env: QA
    label: Quality
    branch: qa
    promotesTo: [PROD]
    mode: pull-request
`;

describe('the Environments page: every environment of the topology, as git says, with this server', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const callAs = (user: string) => async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': user, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const call = callAs(ANA);
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        commitFiles(repo, 'flowtinus/config', { 'topology.yaml': TOPOLOGY }, 'DEV, QA and PROD');

        const show = (ref: string, file: string) =>
            Bun.spawnSync(['git', 'show', `${ref}:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        const filesOf = (ref: string): Record<string, string> =>
            Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', ref)
                    .split('\n')
                    .filter(Boolean)
                    .map(file => [file, show(ref, file)]),
            );
        const branchAt = (branch: string, from: string) => git(repo, 'update-ref', `refs/heads/${branch}`, git(repo, 'rev-parse', from));
        const tip = (branch: string) => git(repo, 'rev-parse', branch);
        const environments = async () => (await call('GET', '/git/environments')).body;
        return { id, handle: workspaceHandleOf(id), call, callAs, repo, projectId, filesOf, branchAt, tip, environments };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-environments-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('the pipeline lists the environments from the root, each with its branch tip; an edge to a missing branch says so', async () => {
        const { branchAt, tip, environments } = await newWorkspace();
        branchAt('qa', 'dev');

        const page = await environments();
        expect(page.on).toBe(true);
        expect(page.environment).toBe('DEV');
        expect(page.pipeline).toEqual([
            { env: 'DEV', label: 'Development', branch: 'dev', mode: 'direct', tip: tip('dev'), here: true },
            { env: 'QA', label: 'Quality', branch: 'qa', mode: 'pull-request', tip: tip('qa'), here: false },
            { env: 'PROD', label: 'Production', branch: 'main', mode: 'protected', tip: null, here: false },
        ]);
        expect(page.edges).toEqual([
            { source: 'DEV', target: 'QA', targetExists: true, behind: 0, ahead: false },
            { source: 'QA', target: 'PROD', targetExists: false, behind: null, ahead: null },
        ]);
    });

    test("behind counts the files promoting the source's tip would change; ahead says whether the target has content its source lacks", async () => {
        const { repo, filesOf, branchAt, environments } = await newWorkspace();
        branchAt('qa', 'dev');
        const edge = async () => (await environments()).edges.find((e: { source: string }) => e.source === 'DEV');

        commitFiles(repo, 'dev', { ...filesOf('dev'), 'a.txt': 'a', 'b.txt': 'b' }, 'Two files');
        expect(await edge()).toMatchObject({ behind: 2, ahead: false });

        commitFiles(repo, 'qa', { ...filesOf('qa'), 'c.txt': 'c' }, 'A change made in QA');
        expect(await edge()).toMatchObject({ behind: 2, ahead: true });

        commitFiles(repo, 'dev', { ...filesOf('dev'), 'c.txt': 'c' }, 'The same change made in DEV');
        expect(await edge()).toMatchObject({ behind: 2, ahead: false });
    });

    const flowText = (text: string, name: string, change: (flow: any, read: any) => [any, any]) => {
        const read = repoFlowFromYaml(text, name);
        if (!read.ok) {
            throw new Error(read.errors.join(' '));
        }
        const [flow, rest] = change(read.value.flow, read.value);
        return repoFlowToYaml(flow, rest);
    };
    const relabel = (flow: any, read: any): [any, any] => [
        { ...flow, nodes: flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label: 'Begin' } : n)) },
        read,
    ];

    test('what runs where: flows by id, each environment from its branch, this server from its own deployment', async () => {
        const { handle, call, repo, projectId, filesOf, branchAt, environments } = await newWorkspace();
        const flow = async (name: string) => (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
        const [orders, invoices] = [await flow('Orders'), await flow('Invoices')];
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        expect((await call('POST', `/flows/${invoices}/deploy`)).status).toBe(200);
        expect((await call('POST', `/flows/${invoices}/undeploy`)).status).toBe(200);
        branchAt('qa', 'dev');

        const same = (state: string) => ({ state, content: 'same', differs: false });
        const runsWhere = async () => (await environments()).runsWhere;
        expect(await runsWhere()).toEqual({
            environments: ['DEV', 'QA', 'PROD'],
            flows: [
                {
                    id: invoices,
                    name: 'Sales/Invoices',
                    cells: { DEV: { state: 'undeployed', content: null, differs: false }, QA: same('undeployed'), PROD: null },
                },
                {
                    id: orders,
                    name: 'Sales/Orders',
                    cells: { DEV: { state: 'deployed', content: null, differs: false }, QA: same('deployed'), PROD: null },
                },
            ],
        });

        const flows = `${handle}/projects/Sales/flows`;
        const onDev = filesOf('dev');
        const relabelled = flowText(onDev[`${flows}/Orders.flow.yaml`]!, 'Orders', relabel);
        commitFiles(
            repo,
            'dev',
            { ...onDev, [`${flows}/Orders.flow.yaml`]: relabelled, [`${handle}/projects/Sales/project.yaml`]: 'id: [not a project' },
            'Relabel Orders, break the project',
        );
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('refused');

        const refunds = crypto.randomUUID();
        const onQa = filesOf('qa');
        delete onQa[`${flows}/Invoices.flow.yaml`];
        commitFiles(
            repo,
            'qa',
            {
                ...onQa,
                [`${flows}/Orders.flow.yaml`]: relabelled,
                [`${flows}/Back office/Refunds.flow.yaml`]: flowText(onDev[`${flows}/Orders.flow.yaml`]!, 'Orders', (f, read) => [
                    { ...f, id: refunds },
                    read,
                ]),
            },
            'QA moves on its own',
        );

        expect(await runsWhere()).toEqual({
            environments: ['DEV', 'QA', 'PROD'],
            flows: [
                {
                    id: refunds,
                    name: 'Sales/Back office/Refunds',
                    cells: {
                        DEV: { state: 'absent', content: null, differs: false },
                        QA: { state: 'deployed', content: null, differs: true },
                        PROD: null,
                    },
                },
                {
                    id: invoices,
                    name: 'Sales/Invoices',
                    cells: {
                        DEV: { state: 'undeployed', content: null, differs: false },
                        QA: { state: 'absent', content: null, differs: true },
                        PROD: null,
                    },
                },
                {
                    id: orders,
                    name: 'Sales/Orders',
                    cells: {
                        DEV: { state: 'deployed', content: null, differs: false },
                        QA: { state: 'deployed', content: 'other', differs: true },
                        PROD: null,
                    },
                },
            ],
        });
    });

    test('every member sees the page; with git off it says only that', async () => {
        const { id, call, callAs, branchAt } = await newWorkspace();
        branchAt('qa', 'dev');
        const viewer = await insertMember(db, id, { name: 'Vera', role: 'viewer' });
        const seen = await callAs(viewer)('GET', '/git/environments');
        expect(seen.status).toBe(200);
        expect(seen.body.pipeline.map((e: { env: string }) => e.env)).toEqual(['DEV', 'QA', 'PROD']);

        expect((await call('DELETE', '/git')).status).toBe(200);
        expect((await call('GET', '/git/environments')).body).toEqual({ on: false });
    });
});
