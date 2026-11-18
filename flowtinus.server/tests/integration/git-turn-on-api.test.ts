import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { exportWorkspace } from '#features/git/workspace-export';
import { GITATTRIBUTES, projectToYaml, repoFlowFromYaml, repoFlowToYaml, workspaceToYaml, type FlowFile } from '@flowtinus/core';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

describe('turning git on', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace() {
        const id = crypto.randomUUID();
        const slug = slugOf(id);
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
        const config = { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' };
        await call('PUT', '/git', config);
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);

        const newProject = async (name: string) => (await call('POST', '/projects', { name })).body.id as string;
        const newFlow = async (projectId: string, name: string) =>
            (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
        const deploy = async (flowId: string) => expect((await call('POST', `/flows/${flowId}/deploy`)).status).toBe(200);
        const tree = () => git(repo, 'ls-tree', '-r', '--name-only', 'dev').split('\n');
        const commits = () => git(repo, 'log', '--format=%an|%s', 'dev').split('\n');
        return { id, slug, call, repo, config, newProject, newFlow, deploy, tree, commits };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-turn-on-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a configuration alone mirrors nothing; turning git on where the branch has no workspace makes the first export', async () => {
        const { id, slug, call, repo, newProject, newFlow, deploy, tree, commits } = await newWorkspace();
        createBranch(repo, 'dev');
        const sales = await newProject('Sales');
        const orders = await newFlow(sales, 'Orders');
        await deploy(orders);
        await newFlow(sales, 'Draft only');
        expect(commits()).toEqual(['Someone|start']);
        expect((await call('GET', '/git')).body).toMatchObject({ on: false });

        const plan = (await call('GET', '/git/on')).body;
        expect(plan).toMatchObject({ branch: 'dev', branchExists: true, case: 'export', toServer: [], errors: [], warnings: [] });
        expect(plan.toGit).toEqual([
            { path: '.gitattributes', change: 'added' },
            { path: `${slug}/projects/Sales/flows/Orders.flow.yaml`, change: 'added' },
            { path: `${slug}/projects/Sales/project.yaml`, change: 'added' },
            { path: `${slug}/workspace.yaml`, change: 'added' },
        ]);

        const on = await call('POST', '/git/on', {});
        expect(on.status).toBe(200);
        expect(on.body).toMatchObject({ outcome: 'exported', branch: 'dev' });
        expect(commits()).toEqual([`Ana|First export of ${slug}`, 'Someone|start']);
        expect(tree()).toEqual(Object.keys(await exportWorkspace(db, id)));
        expect((await call('GET', '/git')).body).toMatchObject({ on: true });

        await deploy(await newFlow(sales, 'Invoices'));
        expect(commits()[0]).toBe('Ana|Deploy Invoices v1');
        expect((await call('POST', '/git/on', {})).body.error).toEqual({ code: 'conflict', message: 'Git is already on.' });
    });

    test('a branch that does not exist is created, empty, only once the admin confirms; the first export follows', async () => {
        const { slug, call, repo, newProject, commits } = await newWorkspace();
        await newProject('Sales');
        const branches = () => git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads');
        expect((await call('GET', '/git/on')).body).toMatchObject({ branch: 'dev', branchExists: false, case: 'export' });

        expect((await call('POST', '/git/on', {})).body.error).toEqual({
            code: 'conflict',
            message: 'The branch dev does not exist: confirm creating it.',
        });
        expect(branches()).toBe('refs/heads/flowtinus/config');
        expect((await call('GET', '/git')).body.on).toBe(false);

        expect((await call('POST', '/git/on', { createBranch: true })).body).toMatchObject({ outcome: 'exported', branch: 'dev' });
        expect(commits()).toEqual([`Ana|First export of ${slug}`, 'Ana|Create dev']);
        expect(git(repo, 'ls-tree', '-r', '--name-only', 'dev~1')).toBe('');
    });

    test('git stays on through a new token secret; another repository or environment turns it off', async () => {
        const { call, repo, config } = await newWorkspace();
        createBranch(repo, 'dev');
        expect((await call('POST', '/git/on', {})).status).toBe(200);
        await call('POST', '/secrets', { name: 'other-token', value: 'tok3n' });

        expect((await call('PUT', '/git', { ...config, tokenSecret: 'other-token' })).body.on).toBe(true);
        expect((await call('PUT', '/git', { ...config, environment: 'PROD' })).body.on).toBe(false);
        expect((await call('GET', '/git')).body.on).toBe(false);
    });

    test('a workspace with projects and connections but no flows is empty: the branch imports, no choice asked', async () => {
        const { slug, call, repo, newProject } = await newWorkspace();
        await newProject('Ops');
        const kafka = { bootstrapServers: 'b:9092', security: 'SASL_SSL', mechanism: 'PLAIN', user: 'u', password: 'kafka-pass' };
        const stream = { name: 'Stream', type: 'kafka', config: kafka, newSecrets: [{ name: 'kafka-pass', value: 's' }] };
        expect((await call('POST', '/connections', stream)).status).toBe(201);
        const sales = crypto.randomUUID();
        commitFiles(repo, 'dev', {
            '.gitattributes': GITATTRIBUTES,
            [`${slug}/workspace.yaml`]: workspaceToYaml(),
            [`${slug}/projects/Sales/project.yaml`]: projectToYaml({ id: sales, description: '' }),
        });

        expect((await call('GET', '/git/on')).body).toMatchObject({ case: 'import', errors: [] });
        expect((await call('POST', '/git/on', {})).body).toMatchObject({ outcome: 'imported' });
        expect((await call('GET', '/projects')).body.items.map((p: { id: string }) => p.id)).toEqual([sales]);
    });

    async function bothWithContent() {
        const workspace = await newWorkspace();
        const { id, slug, repo, newProject, newFlow, deploy } = workspace;
        const sales = await newProject('Sales');
        const orders = await newFlow(sales, 'Orders');
        await deploy(orders);
        const draftOnly = await newFlow(sales, 'Draft only');
        const invoices = crypto.randomUUID();
        const flows = `${slug}/projects/Sales/flows`;
        const { [`${flows}/Orders.flow.yaml`]: ordersFile, ...exported } = await exportWorkspace(db, id);
        const onBranch = {
            ...exported,
            [`${flows}/Invoices.flow.yaml`]: ordersFile!.replace(`id: ${orders}`, `id: ${invoices}`),
            [`${slug}/projects/Sales/project.yaml`]: exported[`${slug}/projects/Sales/project.yaml`]!.replace(
                /^color: .*$/m,
                'color: green',
            ),
        };
        const start = commitFiles(repo, 'dev', onBranch);
        return { ...workspace, sales, orders, ordersFile: ordersFile!, draftOnly, invoices, flows, onBranch, start };
    }

    test('both with content: refused until the admin chooses, each side previewed; nothing changes meanwhile', async () => {
        const { slug, call, repo, flows, start } = await bothWithContent();

        const plan = (await call('GET', '/git/on')).body;
        expect(plan).toMatchObject({ case: 'choice', errors: [] });
        expect(plan.toGit).toEqual([
            { path: `${flows}/Invoices.flow.yaml`, change: 'removed' },
            { path: `${flows}/Orders.flow.yaml`, change: 'added' },
            { path: `${slug}/projects/Sales/project.yaml`, change: 'changed' },
        ]);
        expect(plan.toServer).toEqual([
            { path: `${flows}/Invoices.flow.yaml`, change: 'added' },
            { path: `${flows}/Orders.flow.yaml`, change: 'removed' },
            { path: `${slug}/projects/Sales/project.yaml`, change: 'changed' },
        ]);

        expect((await call('POST', '/git/on', {})).body.error).toEqual({
            code: 'conflict',
            message: `Both dev and this server have the workspace ${slug}: choose whether git replaces the server or the server replaces git.`,
        });
        expect((await call('POST', '/git/on', { choice: 'both' })).status).toBe(400);
        expect(git(repo, 'rev-parse', 'dev')).toBe(start);
        expect((await call('GET', '/git')).body.on).toBe(false);
    });

    test('the server replaces git: one commit makes the branch what the server exports, drafts left out', async () => {
        const { id, slug, call, tree, commits } = await bothWithContent();

        const on = await call('POST', '/git/on', { choice: 'server' });
        expect(on.body).toMatchObject({ outcome: 'server-replaced-git' });
        expect(commits()).toEqual([`Ana|DEV replaces ${slug} in git`, 'Someone|files']);
        expect(tree()).toEqual(Object.keys(await exportWorkspace(db, id)));
        expect(tree()).not.toContain(`${slug}/projects/Sales/flows/Draft only.flow.yaml`);
        expect((await call('GET', '/git')).body.on).toBe(true);
    });

    test('git replaces the server: what git has arrives or changes, what it has not leaves; drafts stay drafts', async () => {
        const { id, call, repo, newProject, newFlow, deploy, commits, sales, orders, ordersFile, draftOnly, invoices, flows, onBranch } =
            await bothWithContent();
        const label = (flow: { nodes: { type: string; label?: string }[] }) => flow.nodes.find(n => n.type === 'start')!.label;
        const draft = (await call('GET', `/flows/${orders}/draft`)).body;
        const withLabel = (flow: FlowFile, text: string) => ({
            ...flow,
            nodes: flow.nodes.map(n => (n.type === 'start' ? { ...n, label: text } : n)),
        });
        await call('PUT', `/flows/${orders}/draft`, { revision: draft.revision, flow: withLabel(draft.flow, 'In my draft') });
        const refunds = await newFlow(sales, 'Refunds');
        await deploy(refunds);
        const ops = await newProject('Ops');
        await deploy(await newFlow(ops, 'Cleanup'));
        await call('POST', `/projects/${sales}/scripts`, { path: 'lib/money', kind: 'script', content: 'export const cents = 100;\n' });
        const kafka = { bootstrapServers: 'b:9092', security: 'SASL_SSL', mechanism: 'PLAIN', user: 'u', password: 'kafka-pass' };
        await call('POST', '/connections', {
            name: 'Stream',
            type: 'kafka',
            config: kafka,
            newSecrets: [{ name: 'kafka-pass', value: 's' }],
        });

        const read = repoFlowFromYaml(ordersFile, 'Orders');
        if (!read.ok) {
            throw new Error(read.errors.join(' '));
        }
        const files = {
            ...onBranch,
            [`${flows}/Daily/Orders.flow.yaml`]: repoFlowToYaml({ ...withLabel(read.value.flow, 'From git'), id: orders }),
            [`${flows.replace('/flows', '/scripts')}/lib/money.ts`]: 'export const cents = 1000;\n',
        };
        commitFiles(repo, 'dev', files);

        const on = await call('POST', '/git/on', { choice: 'git' });
        expect(on.body).toMatchObject({ outcome: 'git-replaced-server' });
        expect(await exportWorkspace(db, id)).toEqual(files);
        expect(commits()[0]).toBe('Someone|files');

        expect((await call('GET', '/projects')).body.items.map((p: { name: string; color: string }) => [p.name, p.color])).toEqual([
            ['Sales', 'green'],
        ]);
        const contents = (await call('GET', `/projects/${sales}/contents`)).body;
        const live = contents.flows.filter((f: { archivedAt: string | null }) => f.archivedAt === null);
        expect(live.map((f: { id: string; deployedVersion: number | null }) => [f.id, f.deployedVersion]).sort()).toEqual(
            [
                [orders, 2],
                [invoices, 1],
                [draftOnly, null],
            ].sort(),
        );
        expect(contents.flows.find((f: { id: string }) => f.id === refunds).archivedAt).not.toBeNull();
        const daily = contents.folders.find((f: { name: string }) => f.name === 'Daily');
        expect(live.find((f: { id: string }) => f.id === orders).folderId).toBe(daily.id);

        expect(label((await call('GET', `/flows/${orders}/draft`)).body.flow)).toBe('In my draft');
        const deployments = (await call('GET', `/flows/${orders}/deployments`)).body;
        expect(label(deployments.versions[0].definition)).toBe('From git');
        expect((await call('GET', `/projects/${sales}/scripts/content?path=lib/money`)).body.content).toBe('export const cents = 1000;\n');
        expect((await call('GET', '/connections')).body.items).toEqual([]);
    });

    test('git replaces the server: the preview says a connection git does not declare is deleted with its configuration', async () => {
        const { slug, call } = await bothWithContent();
        const kafka = { bootstrapServers: 'b:9092', security: 'SASL_SSL', mechanism: 'PLAIN', user: 'u', password: 'kafka-pass' };
        await call('POST', '/connections', {
            name: 'Stream',
            type: 'kafka',
            config: kafka,
            newSecrets: [{ name: 'kafka-pass', value: 's' }],
        });

        expect((await call('GET', '/git/on')).body.toServer).toContainEqual({
            path: `${slug}/connections/Stream.yaml`,
            change: 'removed',
            note: 'The connection Stream is deleted from this server, with its configuration and credentials (the secrets it names stay).',
        });
    });

    test('git replaces the server: a flow with deployed: false and other content gets a new version and no deploy', async () => {
        const { id, call, repo, orders, ordersFile, flows, onBranch } = await bothWithContent();
        const read = repoFlowFromYaml(ordersFile, 'Orders');
        if (!read.ok) {
            throw new Error(read.errors.join(' '));
        }
        const flow = { ...read.value.flow, nodes: read.value.flow.nodes.map(n => (n.type === 'start' ? { ...n, label: 'From git' } : n)) };
        const files = { ...onBranch, [`${flows}/Orders.flow.yaml`]: repoFlowToYaml({ ...flow, id: orders }, { deployed: false }) };
        commitFiles(repo, 'dev', files);

        expect((await call('POST', '/git/on', { choice: 'git' })).body).toMatchObject({ outcome: 'git-replaced-server' });
        const deployments = (await call('GET', `/flows/${orders}/deployments`)).body;
        expect(deployments.versions.map((v: { number: number }) => v.number)).toEqual([2, 1]);
        expect(deployments.deployed).toBeNull();
        expect(deployments.history.map((h: any) => [h.action, h.fromNumber, h.toNumber])).toEqual([
            ['undeploy', 1, null],
            ['deploy', null, 1],
        ]);
        expect(await exportWorkspace(db, id)).toEqual(files);
    });

    test('the files the format does not know are left out: neither side deletes them', async () => {
        const { slug, call, repo, tree, onBranch } = await bothWithContent();
        const unknown = [`${slug}/README.md`, `${slug}/projects/Sales/notes.txt`];
        commitFiles(repo, 'dev', { ...onBranch, [unknown[0]!]: '# Flows\n', [unknown[1]!]: 'todo\n' });

        const plan = (await call('GET', '/git/on')).body;
        const paths = [...plan.toGit, ...plan.toServer].map((c: { path: string }) => c.path);
        expect(paths.filter((path: string) => unknown.includes(path))).toEqual([]);

        expect((await call('POST', '/git/on', { choice: 'git' })).body).toMatchObject({ outcome: 'git-replaced-server' });
        expect(tree()).toEqual(expect.arrayContaining(unknown));
    });

    test('git replaces the server is refused, changing nothing, when a draft here has the name of a flow git brings', async () => {
        const { call, newFlow, sales, orders, flows } = await bothWithContent();
        await newFlow(sales, 'invoices');

        expect((await call('GET', '/git/on')).body.errors).toEqual([
            {
                path: `${flows}/Invoices.flow.yaml`,
                message: 'The flow Invoices in git has the name of a draft here, invoices: rename the draft first.',
            },
        ]);
        expect((await call('POST', '/git/on', { choice: 'git' })).body.error).toEqual({
            code: 'conflict',
            message: 'The flow Invoices in git has the name of a draft here, invoices: rename the draft first.',
        });
        expect((await call('GET', `/projects/${sales}`)).body.color).not.toBe('green');
        expect((await call('GET', `/flows/${orders}/deployments`)).body.deployed).not.toBeNull();
        expect((await call('GET', '/git')).body.on).toBe(false);
    });

    test('git replaces the server refuses an invalid tree whole: nothing changes', async () => {
        const { slug, call, repo, sales, onBranch } = await bothWithContent();
        const project = `${slug}/projects/Sales/project.yaml`;
        commitFiles(repo, 'dev', { ...onBranch, [project]: `owner: ana\n${onBranch[project]}` });

        const refused = await call('POST', '/git/on', { choice: 'git' });
        expect(refused.status).toBe(400);
        expect(refused.body.error.message).toBe('The workspace on dev is not valid: nothing was replaced.');
        expect(Object.keys(refused.body.error.fields)).toEqual([project]);
        expect((await call('GET', `/projects/${sales}`)).body.color).not.toBe('green');
        expect((await call('GET', '/git')).body.on).toBe(false);
    });
});
