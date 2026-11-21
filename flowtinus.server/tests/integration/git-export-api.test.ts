import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitAll, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { exportWorkspace } from '#features/git/workspace-export';
import { validateWorkspaceTree } from '@flowtinus/core';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

describe('every change of the workspace follows into the repository', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace(options: { on?: boolean } = {}) {
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
        createBranch(repo, 'dev');
        if (options.on !== false) {
            expect((await call('POST', '/git/on', {})).status).toBe(200);
        }

        const newProject = async (name: string) => (await call('POST', '/projects', { name })).body.id as string;
        const newFlow = async (projectId: string, name: string, folderId?: string) =>
            (await call('POST', `/projects/${projectId}/flows`, { name, ...(folderId ? { folderId } : {}) })).body.id as string;
        const newFolder = async (projectId: string, name: string, parentId?: string) =>
            (await call('POST', `/projects/${projectId}/folders`, { name, ...(parentId ? { parentId } : {}) })).body.id as string;
        const deploy = async (flowId: string) => expect((await call('POST', `/flows/${flowId}/deploy`)).status).toBe(200);
        const tree = () =>
            git(repo, 'ls-tree', '-r', '--name-only', 'dev')
                .split('\n')
                .filter(path => path.startsWith(`${handle}/`) && path !== `${handle}/workspace.yaml`)
                .map(path => path.slice(handle.length + 1));
        const show = (path: string) => git(repo, 'show', `dev:${handle}/${path}`);
        const lastCommit = () => git(repo, 'log', '-1', '--format=%an|%s', 'dev');
        const commit = async (message: string) => expect((await commitAll(call, message)).status).toBe(200);
        return { id, handle, call, repo, newProject, newFlow, newFolder, deploy, tree, show, lastCommit, commit };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-export-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a renamed or moved flow moves its file at its Commit, the same content at the path its names give', async () => {
        const { call, newProject, newFlow, newFolder, deploy, tree, show, lastCommit, commit } = await newWorkspace();
        const sales = await newProject('Sales');
        const orders = await newFlow(sales, 'Orders');
        await deploy(orders);
        const file = show('projects/Sales/flows/Orders.flow.yaml');

        expect((await call('PATCH', `/flows/${orders}`, { name: 'Invoices' })).status).toBe(200);
        expect(tree()).toEqual(['projects/Sales/flows/Orders.flow.yaml', 'projects/Sales/project.yaml']);
        await commit('Rename flow Orders to Invoices');
        expect(tree()).toEqual(['projects/Sales/flows/Invoices.flow.yaml', 'projects/Sales/project.yaml']);
        expect(show('projects/Sales/flows/Invoices.flow.yaml')).toBe(file);
        expect(lastCommit()).toBe('Ana|Rename flow Orders to Invoices');

        const imports = await newFolder(sales, 'Imports');
        expect((await call('POST', `/flows/${orders}/move`, { folderId: imports })).status).toBe(200);
        await commit('Move flow Invoices to Imports');
        expect(tree()).toEqual(['projects/Sales/flows/Imports/Invoices.flow.yaml', 'projects/Sales/project.yaml']);
        expect(lastCommit()).toBe('Ana|Move flow Invoices to Imports');
    });

    test('an empty folder keeps a .gitkeep; a renamed or moved folder moves its files; an archived one leaves', async () => {
        const { call, newProject, newFlow, newFolder, deploy, tree, lastCommit, commit } = await newWorkspace();
        const sales = await newProject('Sales');
        const imports = await newFolder(sales, 'Imports');
        await commit('Create folder Imports');
        expect(tree()).toEqual(['projects/Sales/flows/Imports/.gitkeep', 'projects/Sales/project.yaml']);
        expect(lastCommit()).toBe('Ana|Create folder Imports');

        const daily = await newFolder(sales, 'Daily', imports);
        const orders = await newFlow(sales, 'Orders', daily);
        await deploy(orders);
        await commit('Create folder Daily');
        expect(tree()).toEqual(['projects/Sales/flows/Imports/Daily/Orders.flow.yaml', 'projects/Sales/project.yaml']);

        expect((await call('PATCH', `/folders/${imports}`, { name: 'Loads' })).status).toBe(200);
        await commit('Rename folder Imports to Loads');
        expect(tree()).toEqual(['projects/Sales/flows/Loads/Daily/Orders.flow.yaml', 'projects/Sales/project.yaml']);
        expect(lastCommit()).toBe('Ana|Rename folder Imports to Loads');

        expect((await call('POST', `/folders/${daily}/move`, { parentId: null })).status).toBe(200);
        await commit('Move folder Daily to the top');
        expect(tree()).toEqual([
            'projects/Sales/flows/Daily/Orders.flow.yaml',
            'projects/Sales/flows/Loads/.gitkeep',
            'projects/Sales/project.yaml',
        ]);

        expect((await call('POST', `/folders/${daily}/archive`)).status).toBe(200);
        await commit('Archive folder Daily');
        expect(tree()).toEqual(['projects/Sales/flows/Loads/.gitkeep', 'projects/Sales/project.yaml']);

        expect((await call('POST', `/folders/${daily}/restore`)).status).toBe(200);
        await commit('Restore folder Daily');
        expect(tree()).toEqual([
            'projects/Sales/flows/Daily/Orders.flow.yaml',
            'projects/Sales/flows/Loads/.gitkeep',
            'projects/Sales/project.yaml',
        ]);
        expect(lastCommit()).toBe('Ana|Restore folder Daily');
        // a dozen commits, each pushed and reconciled: beside the other suites it outlasts 30 s
    }, 90_000);

    test('an archived flow leaves the repository at its Commit; restored, it comes back not deployed', async () => {
        const { call, newProject, newFlow, deploy, tree, show, lastCommit, commit } = await newWorkspace();
        const sales = await newProject('Sales');
        const orders = await newFlow(sales, 'Orders');
        await deploy(orders);

        expect((await call('POST', `/flows/${orders}/archive`)).status).toBe(200);
        await commit('Archive flow Orders');
        expect(tree()).toEqual(['projects/Sales/project.yaml']);
        expect(lastCommit()).toBe('Ana|Archive flow Orders');

        expect((await call('POST', `/flows/${orders}/restore`)).status).toBe(200);
        await commit('Restore flow Orders');
        expect(show('projects/Sales/flows/Orders.flow.yaml')).toContain(`id: ${orders}\ndeployed: false\n`);
        expect(lastCommit()).toBe('Ana|Restore flow Orders');
    });

    test("a project's file follows its fields; renamed, archived or restored, the project's files move, leave or come back", async () => {
        const { call, newProject, newFlow, deploy, tree, show, lastCommit, commit } = await newWorkspace();
        const sales = await newProject('Sales');
        await deploy(await newFlow(sales, 'Orders'));
        expect(show('projects/Sales/project.yaml')).toBe(`id: ${sales}\nicon: folder\ncolor: blue`);

        expect((await call('PATCH', `/projects/${sales}`, { name: 'Revenue', description: 'Money in', color: 'green' })).status).toBe(200);
        await commit('Update project Revenue');
        expect(tree()).toEqual(['projects/Revenue/flows/Orders.flow.yaml', 'projects/Revenue/project.yaml']);
        expect(show('projects/Revenue/project.yaml')).toBe(`id: ${sales}\ndescription: Money in\nicon: folder\ncolor: green`);
        expect(lastCommit()).toBe('Ana|Update project Revenue');

        expect((await call('POST', `/projects/${sales}/archive`)).status).toBe(200);
        await commit('Archive project Revenue');
        expect(tree()).toEqual([]);

        expect((await call('POST', `/projects/${sales}/restore`)).status).toBe(200);
        await commit('Restore project Revenue');
        expect(tree()).toEqual(['projects/Revenue/flows/Orders.flow.yaml', 'projects/Revenue/project.yaml']);
        expect(lastCommit()).toBe('Ana|Restore project Revenue');
    });

    test('scripts are files at their paths: created, saved, moved and deleted in the working copy; an empty script folder keeps a .gitkeep', async () => {
        const { call, newProject, tree, show, lastCommit, commit } = await newWorkspace();
        const sales = await newProject('Sales');
        const scripts = `/projects/${sales}/scripts`;

        expect((await call('POST', scripts, { path: 'lib/money', kind: 'script', content: 'export const cents = 100;\n' })).status).toBe(
            201,
        );
        await commit('Create script lib/money');
        expect(show('projects/Sales/scripts/lib/money.ts')).toBe('export const cents = 100;');

        const saved = await call('PUT', `${scripts}/content`, { path: 'lib/money', content: 'export const cents = 1000;\n', revision: 0 });
        expect(saved.status).toBe(200);
        expect(show('projects/Sales/scripts/lib/money.ts')).toBe('export const cents = 100;');
        expect(lastCommit()).toBe('Ana|Create script lib/money');

        expect((await call('POST', `${scripts}/move`, { from: 'lib', to: 'shared' })).status).toBe(200);
        await commit('Move script lib to shared');
        expect(tree()).toEqual(['projects/Sales/project.yaml', 'projects/Sales/scripts/shared/money.ts']);
        expect(show('projects/Sales/scripts/shared/money.ts')).toBe('export const cents = 1000;');

        expect((await call('POST', scripts, { path: 'drafts', kind: 'folder' })).status).toBe(201);
        expect((await call('POST', `${scripts}/delete`, { path: 'shared/money' })).status).toBe(200);
        await commit('Delete script shared/money');
        expect(tree()).toEqual(['projects/Sales/project.yaml', 'projects/Sales/scripts/drafts/.gitkeep']);
        expect(lastCommit()).toBe('Ana|Delete script shared/money');
    });

    test('a connection is declared by its id and type, the name in the path: never its configuration or credentials', async () => {
        const { call, tree, show, lastCommit, commit } = await newWorkspace();
        const fields = {
            name: 'Events',
            type: 'kafka',
            config: { bootstrapServers: 'b:9092', security: 'SASL_SSL', mechanism: 'PLAIN', user: 'u', password: 'kafka-pass' },
        };
        const created = await call('POST', '/connections', { ...fields, newSecrets: [{ name: 'kafka-pass', value: 's3cret' }] });
        expect(created.status).toBe(201);
        const id = created.body.id as string;
        await commit('Create connection Events');
        expect(show('connections/Events.yaml')).toBe(`id: ${id}\ntype: kafka`);

        expect((await call('PUT', `/connections/${id}`, { ...fields, config: { ...fields.config, user: 'v' } })).status).toBe(200);
        expect((await call('GET', '/git/changes')).body.changes).toEqual([]);

        expect((await call('PUT', `/connections/${id}`, { ...fields, name: 'Stream' })).status).toBe(200);
        await commit('Update connection Stream');
        expect(tree()).toEqual(['connections/Stream.yaml']);

        expect((await call('DELETE', `/connections/${id}`)).status).toBe(200);
        await commit('Delete connection Stream');
        expect(tree()).toEqual([]);
        expect(lastCommit()).toBe('Ana|Delete connection Stream');
    });

    test('a project moved to another workspace leaves the repository of one and reaches the repository of the other', async () => {
        const from = await newWorkspace();
        const to = await newWorkspace();
        const sales = await from.newProject('Sales');
        const orders = await from.newFlow(sales, 'Orders');
        await from.deploy(orders);

        expect((await from.call('POST', `/projects/${sales}/move`, { toWorkspace: to.handle })).status).toBe(200);
        await from.commit(`Move project Sales to ${to.handle}`);
        await to.commit(`Move project Sales from ${from.handle}`);
        expect(from.tree()).toEqual([]);
        expect(to.tree()).toEqual(['projects/Sales/flows/Orders.flow.yaml', 'projects/Sales/project.yaml']);
        expect(to.show('projects/Sales/flows/Orders.flow.yaml')).toContain(`id: ${orders}\n`);
        // two workspaces, each turned on and committed to: beside the other suites it outlasts 30 s
    }, 90_000);

    test('the first export writes the whole workspace: .gitattributes, workspace.yaml and what is deployed, with no value', async () => {
        const { id, handle, call, repo, newProject, newFlow, newFolder, deploy, lastCommit } = await newWorkspace({ on: false });
        await call('POST', '/variables', { name: 'region', value: 'eu-west-9' });
        const kafka = { bootstrapServers: 'b:9092', security: 'SASL_SSL', mechanism: 'PLAIN', user: 'u', password: 'kafka-pass' };
        const events = await call('POST', '/connections', {
            name: 'Events',
            type: 'kafka',
            config: kafka,
            newSecrets: [{ name: 'kafka-pass', value: 's3cret' }],
        });
        const sales = await newProject('Sales');
        await newFolder(sales, 'Later');
        await deploy(await newFlow(sales, 'Orders'));
        await newFlow(sales, 'Draft only');
        await call('POST', `/projects/${sales}/scripts`, { path: 'lib/money', kind: 'script', content: 'export const cents = 100;\n' });

        expect((await call('POST', '/git/on', {})).status).toBe(200);

        expect(git(repo, 'ls-tree', '-r', '--name-only', 'dev').split('\n')).toEqual([
            '.gitattributes',
            `${handle}/connections/Events.yaml`,
            `${handle}/projects/Sales/flows/Later/.gitkeep`,
            `${handle}/projects/Sales/flows/Orders.flow.yaml`,
            `${handle}/projects/Sales/project.yaml`,
            `${handle}/projects/Sales/scripts/lib/money.ts`,
            `${handle}/workspace.yaml`,
        ]);
        expect(git(repo, 'show', 'dev:.gitattributes')).toBe('* text=auto eol=lf');
        expect(git(repo, 'show', `dev:${handle}/workspace.yaml`)).toBe('format: 1');
        expect(lastCommit()).toBe(`Ana|First export of ${handle}`);
        const environment = { connections: [events.body.id as string], secrets: ['kafka-pass'], variables: ['region'] };
        expect(validateWorkspaceTree({ workspace: handle, files: await exportWorkspace(db, id), environment })).toEqual({
            errors: [],
            warnings: [],
        });
        for (const value of ['s3cret', 'eu-west-9', 'b:9092']) {
            expect(Bun.spawnSync(['git', 'grep', '-q', value, 'dev'], { cwd: repo }).exitCode).toBe(1);
        }
    });
});
