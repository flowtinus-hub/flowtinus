import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectionToYaml, GITATTRIBUTES, projectToYaml, repoFlowToYaml, workspaceToYaml, type FlowFile, type FlowFileNode } from '@flowtinus/core';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitFiles, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

const at = (x: number) => ({ x, y: 0 });

const flow = (id: string, nodes: FlowFileNode[] = []): FlowFile => ({
    version: 1,
    id,
    name: '',
    nodes: [
        { id: 'start', type: 'start', position: at(0), config: {} },
        ...nodes,
        { id: 'end', type: 'end', position: at(900), config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: nodes[0]?.id ?? 'end', targetPort: 'in-0' },
        ...nodes.map((n, i) => ({ source: n.id, sourcePort: 'out-0', target: nodes[i + 1]?.id ?? 'end', targetPort: 'in-0' })),
    ],
});

const logFlow = (id: string, message: string) => flow(id, [{ id: 'log', type: 'log', position: at(100), config: { message } }]);

type Files = Record<string, string>;

describe("the reconcile applies the tip of the environment's branch", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace() {
        const id = crypto.randomUUID();
        const handle = workspaceHandleOf(id);
        await insertWorkspace(db, id);
        const call = async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);

        const ids = { sales: crypto.randomUUID(), orders: crypto.randomUUID(), notify: crypto.randomUUID() };
        const p = (path: string) => `${handle}/${path}`;
        const paths = {
            project: p('projects/Sales/project.yaml'),
            orders: p('projects/Sales/flows/Daily/Orders.flow.yaml'),
            notify: p('projects/Sales/flows/Notify.flow.yaml'),
        };
        commitFiles(repo, 'dev', {
            '.gitattributes': GITATTRIBUTES,
            [p('workspace.yaml')]: workspaceToYaml(),
            [paths.project]: projectToYaml({ id: ids.sales, description: 'Money in', icon: 'cart', color: 'green' }),
            [paths.orders]: repoFlowToYaml(logFlow(ids.orders, 'v1')),
            [paths.notify]: repoFlowToYaml(logFlow(ids.notify, 'hi')),
        });
        expect((await call('POST', '/git/on', {})).status).toBe(200);

        const onBranch = (): Files => {
            const names = git(repo, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'dev').split('\n');
            const show = (path: string) => Bun.spawnSync(['git', 'show', `dev:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
            return Object.fromEntries(names.map(path => [path, show(path)]));
        };
        const commit = (change: (files: Files) => Files, message = 'by hand') => commitFiles(repo, 'dev', change(onBranch()), message);
        const reconcile = () => call('POST', '/git/reconcile');
        const contents = async () => (await call('GET', `/projects/${ids.sales}/contents`)).body;
        const flowNamed = async (name: string) => (await contents()).flows.find((f: { name: string }) => f.name === name);
        const deployments = async (flowId: string) => (await call('GET', `/flows/${flowId}/deployments`)).body;
        return { id, handle, call, repo, ids, paths, p, onBranch, commit, reconcile, contents, flowNamed, deployments };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-reconcile-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a commit made with git that changes, adds, renames and moves flows, a project and a folder is applied', async () => {
        const { call, ids, paths, p, commit, reconcile, contents, flowNamed, deployments } = await newWorkspace();
        const added = crypto.randomUUID();
        const sha = commit(files => {
            const { [paths.notify]: notify, [paths.orders]: _orders, ...rest } = files;
            return {
                ...rest,
                [paths.project]: projectToYaml({ id: ids.sales, description: 'Money out', icon: 'cart', color: 'red' }),
                [p('projects/Sales/flows/Weekly/Orders.flow.yaml')]: repoFlowToYaml(logFlow(ids.orders, 'v2')),
                [p('projects/Sales/flows/Alert.flow.yaml')]: notify!,
                [p('projects/Sales/flows/Invoices.flow.yaml')]: repoFlowToYaml(logFlow(added, 'new')),
                [p('projects/Sales/flows/Later/.gitkeep')]: '',
            };
        });

        const reconciled = await reconcile();
        expect(reconciled.status).toBe(200);
        expect(reconciled.body).toMatchObject({ outcome: 'applied', branch: 'dev', commit: sha, errors: [], renamedDrafts: [] });

        expect((await call('GET', '/projects')).body.items).toEqual([
            expect.objectContaining({ id: ids.sales, description: 'Money out', color: 'red' }),
        ]);
        const tree = await contents();
        const folder = (name: string) =>
            tree.folders.find((f: { name: string; archivedAt: string | null }) => f.name === name && !f.archivedAt);
        expect(folder('Daily')).toBeUndefined();
        expect(folder('Later')).toBeDefined();
        expect(await flowNamed('Orders')).toMatchObject({ id: ids.orders, folderId: folder('Weekly').id, deployedVersion: 2 });
        expect(await flowNamed('Alert')).toMatchObject({ id: ids.notify, folderId: null, deployedVersion: 1 });
        expect(await flowNamed('Invoices')).toMatchObject({ id: added, deployedVersion: 1 });
        expect(await flowNamed('Notify')).toBeUndefined();

        const orders = await deployments(ids.orders);
        expect(orders.versions.map((v: { number: number; commit: string | null }) => [v.number, v.commit])).toEqual([
            [2, sha],
            [1, null],
        ]);
        expect(orders.versions[0].definition.nodes.find((n: { id: string }) => n.id === 'log').config.message).toBe('v2');
        expect(orders.history[0]).toMatchObject({ action: 'deploy', fromNumber: 1, toNumber: 2, commit: sha });
        expect((await deployments(added)).history).toEqual([expect.objectContaining({ action: 'deploy', toNumber: 1, commit: sha })]);
        expect((await deployments(ids.notify)).versions).toHaveLength(1);
    });

    test('ten commits at once give one new version per flow, with the sha of the tip; the same tip again changes nothing', async () => {
        const { ids, paths, commit, reconcile, deployments } = await newWorkspace();
        let tip = '';
        for (let i = 2; i <= 11; i++) {
            tip = commit(files => ({ ...files, [paths.orders]: repoFlowToYaml(logFlow(ids.orders, `v${i}`)) }), `Change ${i}`);
        }

        expect((await reconcile()).body).toMatchObject({ outcome: 'applied', commit: tip });
        const orders = await deployments(ids.orders);
        expect(orders.versions.map((v: { number: number; commit: string | null }) => [v.number, v.commit])).toEqual([
            [2, tip],
            [1, null],
        ]);
        expect(orders.versions[0].definition.nodes.find((n: { id: string }) => n.id === 'log').config.message).toBe('v11');
        expect(orders.history.filter((h: { commit: string | null }) => h.commit === tip)).toHaveLength(1);

        expect((await reconcile()).body).toMatchObject({ outcome: 'up-to-date', commit: tip });
        expect((await deployments(ids.orders)).history).toHaveLength(orders.history.length);
    });

    test('a flow set to deployed: false is undeployed by the commit, with its sha', async () => {
        const { ids, paths, commit, reconcile, deployments } = await newWorkspace();
        const sha = commit(files => ({ ...files, [paths.orders]: repoFlowToYaml(logFlow(ids.orders, 'v1'), { deployed: false }) }));

        expect((await reconcile()).body.outcome).toBe('applied');
        const orders = await deployments(ids.orders);
        expect(orders.deployed).toBeNull();
        expect(orders.history[0]).toMatchObject({ action: 'undeploy', fromNumber: 1, commit: sha });
    });

    test('an invalid tree is refused whole and kept with its errors; the next commit is validated on its own tree', async () => {
        const { call, ids, paths, p, commit, reconcile, flowNamed, deployments } = await newWorkspace();
        const broken = p('connections/Warehouse.yaml');
        const refused = commit(files => ({
            ...files,
            [paths.project]: projectToYaml({ id: ids.sales, description: 'Money out', icon: 'cart', color: 'green' }),
            [paths.orders]: repoFlowToYaml(logFlow(ids.orders, 'v2')),
            [broken]: connectionToYaml({ id: crypto.randomUUID(), type: 'oracle' as never }),
        }));

        const first = await reconcile();
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({
            outcome: 'refused',
            commit: refused,
            errors: [{ path: broken, message: 'Unknown connection type "oracle".' }],
        });
        expect((await call('GET', '/projects')).body.items[0].description).toBe('Money in');
        expect((await deployments(ids.orders)).versions).toHaveLength(1);
        expect((await call('GET', '/connections')).body.items).toEqual([]);

        const again = await reconcile();
        expect(again.body).toEqual(first.body);

        const fixed = commit(files => {
            const { [broken]: _broken, ...rest } = files;
            return rest;
        });
        expect((await reconcile()).body).toMatchObject({ outcome: 'applied', commit: fixed, errors: [] });
        expect((await call('GET', '/projects')).body.items[0].description).toBe('Money out');
        expect(await flowNamed('Orders')).toMatchObject({ deployedVersion: 2 });
        expect((await deployments(ids.orders)).versions[0].commit).toBe(fixed);
    });

    test('a commit adding a project whose handle another project has, archived ones included, is refused', async () => {
        const { call, p, commit, reconcile } = await newWorkspace();
        const project = () => projectToYaml({ id: crypto.randomUUID(), description: '' });
        commit(files => ({ ...files, [p('projects/sales!/project.yaml')]: project() }));
        expect((await reconcile()).body).toMatchObject({
            outcome: 'refused',
            errors: [{ path: p('projects/sales!'), message: 'The handle "sales" is taken by the project "Sales".' }],
        });

        commit(files => {
            const { [p('projects/sales!/project.yaml')]: _clash, ...rest } = files;
            return rest;
        });
        expect((await reconcile()).body.outcome).toBe('applied');
        const old = (await call('POST', '/projects', { name: 'Old Reports' })).body.id as string;
        expect((await call('POST', `/projects/${old}/archive`)).status).toBe(200);
        commit(files => ({ ...files, [p('projects/old reports/project.yaml')]: project() }));
        expect((await reconcile()).body).toMatchObject({
            outcome: 'refused',
            errors: [
                { path: p('projects/old reports'), message: 'The handle "old-reports" is taken by the archived project "Old Reports".' },
            ],
        });
    });

    test('a connection removed by git is archived with its configuration; a commit that brings its id back brings it back configured', async () => {
        const { call, p, commit, reconcile } = await newWorkspace();
        const fields = {
            name: 'Events',
            type: 'kafka',
            config: { bootstrapServers: 'b:9092', security: 'SASL_SSL', mechanism: 'PLAIN', user: 'u', password: 'kafka-pass' },
        };
        const created = await call('POST', '/connections', { ...fields, newSecrets: [{ name: 'kafka-pass', value: 's3cret' }] });
        expect(created.status).toBe(201);
        const path = p('connections/Events.yaml');
        const declared = connectionToYaml({ id: created.body.id, type: 'kafka' });
        expect((await call('POST', '/git/commit', { paths: [path], message: 'Create connection Events' })).status).toBe(200);
        expect((await reconcile()).body.outcome).toBe('up-to-date');

        commit(files => {
            const { [path]: _events, ...rest } = files;
            return rest;
        });
        expect((await reconcile()).body.outcome).toBe('applied');
        expect((await call('GET', '/connections')).body.items).toEqual([]);
        expect((await call('GET', '/secrets')).body.items.map((s: { name: string }) => s.name)).toContain('kafka-pass');

        const other = await call('POST', '/connections', { ...fields, config: { ...fields.config, user: 'w' } });
        expect(other.status).toBe(201);
        commit(files => {
            const { [path]: _other, ...rest } = files;
            return { ...rest, [p('connections/Stream.yaml')]: declared };
        });

        expect((await reconcile()).body.outcome).toBe('applied');
        expect((await call('GET', '/connections')).body.items).toEqual([
            expect.objectContaining({ id: other.body.id, name: 'Events' }),
            expect.objectContaining({ id: created.body.id, name: 'Stream', type: 'kafka', config: expect.objectContaining(fields.config) }),
        ]);
    });

    test('a flow deleted by git while it has a draft goes to the archive with its draft, marked as deleted by that commit', async () => {
        const { call, ids, paths, commit, reconcile, contents, deployments } = await newWorkspace();
        const draft = (await call('GET', `/flows/${ids.orders}/draft`)).body;
        const nodes = draft.flow.nodes.map((n: FlowFileNode) => (n.id === 'log' ? { ...n, config: { message: 'mine' } } : n));
        expect((await call('PUT', `/flows/${ids.orders}/draft`, { revision: draft.revision, flow: { ...draft.flow, nodes } })).status).toBe(
            200,
        );

        const sha = commit(files => {
            const { [paths.orders]: _orders, ...rest } = files;
            return rest;
        });
        expect((await reconcile()).body.outcome).toBe('applied');

        const archived = (await contents()).flows.find((f: { id: string }) => f.id === ids.orders);
        expect(archived).toMatchObject({ archivedByCommit: sha, deployedVersion: null });
        expect(archived.archivedAt).not.toBeNull();
        const kept = (await call('GET', `/flows/${ids.orders}/draft`)).body.flow;
        expect(kept.nodes.find((n: FlowFileNode) => n.id === 'log').config.message).toBe('mine');
        expect((await deployments(ids.orders)).history[0]).toMatchObject({ action: 'undeploy', commit: sha });

        expect((await call('POST', `/flows/${ids.orders}/restore`)).body).toMatchObject({ archivedAt: null, archivedByCommit: null });
    });

    test('a draft-only flow whose name a commit takes is renamed "<name> (draft)", and the outcome says so', async () => {
        const { call, ids, p, commit, reconcile, contents } = await newWorkspace();
        const draftId = (await call('POST', `/projects/${ids.sales}/flows`, { name: 'Report' })).body.id as string;
        const taken = (await call('POST', `/projects/${ids.sales}/flows`, { name: 'Report (draft)' })).body.id as string;
        const fromGit = crypto.randomUUID();
        commit(files => ({ ...files, [p('projects/Sales/flows/report.flow.yaml')]: repoFlowToYaml(logFlow(fromGit, 'git')) }));

        const reconciled = await reconcile();
        expect(reconciled.body).toMatchObject({
            outcome: 'applied',
            renamedDrafts: [{ id: draftId, from: 'Report', to: 'Report (draft 2)' }],
        });
        const names = Object.fromEntries((await contents()).flows.map((f: { id: string; name: string }) => [f.id, f.name]));
        expect(names[draftId]).toBe('Report (draft 2)');
        expect(names[taken]).toBe('Report (draft)');
        expect(names[fromGit]).toBe('report');
    });

    test('a draft renamed by the poll is kept with the commit applied: the status says so until the next commit applies', async () => {
        const { id, call, ids, p, commit, flowNamed } = await newWorkspace();
        const draftId = (await call('POST', `/projects/${ids.sales}/flows`, { name: 'Report' })).body.id as string;
        const fromGit = crypto.randomUUID();
        const sha = commit(files => ({ ...files, [p('projects/Sales/flows/Report.flow.yaml')]: repoFlowToYaml(logFlow(fromGit, 'git')) }));

        await app.gitPoller.poll(id);
        const status = (await call('GET', '/git/status')).body;
        expect(status.deploy.sha).toBe(sha);
        expect(status.renamedDrafts).toEqual([{ id: draftId, from: 'Report', to: 'Report (draft)' }]);
        expect((await flowNamed('Report (draft)')).id).toBe(draftId);

        commit(files => ({ ...files, [p('projects/Sales/flows/Other.flow.yaml')]: repoFlowToYaml(logFlow(crypto.randomUUID(), 'other')) }));
        await app.gitPoller.poll(id);
        expect((await call('GET', '/git/status')).body.renamedDrafts).toEqual([]);
    });

    test('a workspace without git configuration has nothing to reconcile', async () => {
        const { call, reconcile } = await newWorkspace();
        expect((await call('DELETE', '/git')).status).toBe(200);
        expect((await reconcile()).status).toBe(409);
    });
});
