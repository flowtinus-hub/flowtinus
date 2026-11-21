import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ANA, BIA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitAll, createBranch, git } from '../helpers/git-repos';
import { API_SCOPES, insertApiToken, newApiToken } from '#features/api-tokens/api-tokens';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(180_000);

type Change = { path: string; from?: string; change: string };

const shopConnection = {
    name: 'Shop',
    type: 'kafka',
    config: { bootstrapServers: 'b:9092', security: 'SASL_SSL', mechanism: 'PLAIN', user: 'u', password: 'kafka-pass' },
    newSecrets: [{ name: 'kafka-pass', value: 's3cret' }],
};

describe('every change of the tree on a work branch goes into its working copy', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const as = (user: string) => async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': user, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const call = as(ANA);
        const onDev = as(BIA);
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        const orders = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        const warehouse = (await call('POST', '/connections', { ...shopConnection, name: 'Warehouse' })).body.id as string;
        expect((await commitAll(call, 'Warehouse')).status).toBe(200);
        await app.gitPoller.poll(id);

        const slug = slugOf(id);
        const at = (path: string) => `${slug}/${path}`;
        const handle = (await call('GET', '/me')).body.handle as string;
        const branch = `users/${handle}/tree`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);

        const show = (ref: string, path: string) => git(repo, 'show', `${ref}:${at(path)}`);
        const tree = (ref: string) =>
            git(repo, 'ls-tree', '-r', '--name-only', ref)
                .split('\n')
                .filter(path => path.startsWith(`${slug}/`))
                .map(path => path.slice(slug.length + 1));
        const changes = async (user = ANA) =>
            ((await as(user)('GET', '/git/changes')).body.changes as Change[]).map(c =>
                c.from ? `${c.from.slice(slug.length + 1)} -> ${c.path.slice(slug.length + 1)}` : c.path.slice(slug.length + 1),
            );
        const contents = async (project = projectId, user = ANA) => {
            const body = (await as(user)('GET', `/projects/${project}/contents`)).body;
            const named = (items: { name: string; archivedAt: string | null }[], archived: boolean) =>
                items.filter(i => (i.archivedAt !== null) === archived).map(i => i.name);
            return {
                folders: named(body.folders, false),
                flows: named(body.flows, false),
                archivedFolders: named(body.folders, true),
                archivedFlows: named(body.flows, true),
                body,
            };
        };
        const projects = async (status: 'active' | 'archived' = 'active', user = ANA) =>
            ((await as(user)('GET', `/projects?status=${status}`)).body.items as { name: string }[]).map(p => p.name);
        const devTip = () => git(repo, 'rev-parse', 'dev');
        return { id, call, onDev, projectId, orders, warehouse, repo, branch, show, tree, changes, contents, projects, devTip };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-work-branch-tree-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('projects: create, rename, archive, restore and discard on the branch; committed and read back with git', async () => {
        const { call, onDev, projectId, branch, show, tree, changes, contents, projects, devTip } = await workspace();
        const dev = devTip();

        const ops = await call('POST', '/projects', { name: 'Ops', description: 'Night jobs' });
        expect(ops.status).toBe(201);
        expect(await changes()).toEqual(['projects/Ops/project.yaml']);
        expect(await projects()).toEqual(['Ops', 'Sales']);
        expect(await projects('active', BIA)).toEqual(['Sales']);
        expect((await call('POST', '/projects', { name: 'ops' })).status).toBe(409);

        const renamed = await call('PATCH', `/projects/${projectId}`, { name: 'Sales 2', color: 'green' });
        expect(renamed.status).toBe(200);
        expect(renamed.body).toMatchObject({ id: projectId, name: 'Sales 2', color: 'green' });
        expect(await changes()).toEqual([
            'projects/Ops/project.yaml',
            'projects/Sales/flows/Orders.flow.yaml -> projects/Sales 2/flows/Orders.flow.yaml',
            'projects/Sales/project.yaml -> projects/Sales 2/project.yaml',
        ]);
        expect((await contents()).flows).toEqual(['Orders']);

        expect((await commitAll(call, 'Projects on a branch')).status).toBe(200);
        expect(show(branch, 'projects/Ops/project.yaml')).toContain('description: Night jobs');
        expect(show(branch, 'projects/Sales 2/project.yaml')).toContain('color: green');
        expect(tree(branch).filter(path => path.startsWith('projects/Sales/'))).toEqual([]);
        expect(devTip()).toBe(dev);
        expect(await projects('active', BIA)).toEqual(['Sales']);
        expect(await changes()).toEqual([]);

        expect((await call('POST', `/projects/${projectId}/archive`)).status).toBe(200);
        expect(await changes()).toEqual(['projects/Sales 2/flows/Orders.flow.yaml', 'projects/Sales 2/project.yaml']);
        expect(await projects()).toEqual(['Ops']);
        expect(await projects('archived')).toEqual(['Sales 2']);
        expect((await call('GET', `/projects/${projectId}`)).body.archivedAt).not.toBeNull();
        expect((await contents()).archivedFlows).toEqual(['Orders']);
        const restored = await call('POST', `/projects/${projectId}/restore`);
        expect(restored.status).toBe(200);
        expect(restored.body).toMatchObject({ name: 'Sales 2', archivedAt: null });
        expect(await changes()).toEqual([]);
        expect((await contents()).flows).toEqual(['Orders']);

        expect((await call('POST', `/projects/${ops.body.id}/archive`)).status).toBe(200);
        expect(await changes()).toEqual(['projects/Ops/project.yaml']);
        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect(await projects()).toEqual(['Ops', 'Sales 2']);

        expect((await call('POST', `/projects/${ops.body.id}/archive`)).status).toBe(200);
        expect((await commitAll(call, 'Archive Ops')).status).toBe(200);
        expect(tree(branch).filter(path => path.startsWith('projects/Ops/'))).toEqual([]);
        expect(await projects('archived')).toEqual(['Ops']);
        expect((await call('POST', `/projects/${ops.body.id}/restore`)).status).toBe(200);
        expect(await changes()).toEqual(['projects/Ops/project.yaml']);
        expect((await commitAll(call, 'Restore Ops')).status).toBe(200);
        expect(show(branch, 'projects/Ops/project.yaml')).toContain(`id: ${ops.body.id}`);

        expect(devTip()).toBe(dev);
        expect(await changes(BIA)).toEqual([]);
        expect((await onDev('GET', `/projects/${projectId}`)).body.name).toBe('Sales');
    });

    test('projects on the branch: a handle another project has, archived ones included, refuses the create and the rename', async () => {
        const { call, projectId } = await workspace();
        const message = (r: { body: any }) => r.body.error?.message;

        expect(message(await call('POST', '/projects', { name: 'sales!' }))).toBe('The handle "sales" is taken by the project "Sales".');
        const ops = (await call('POST', '/projects', { name: 'Ops' })).body.id as string;
        expect(message(await call('PATCH', `/projects/${ops}`, { name: 'SALES' }))).toBe(
            'The handle "sales" is taken by the project "Sales".',
        );

        expect((await call('POST', `/projects/${projectId}/archive`)).status).toBe(200);
        expect(message(await call('POST', '/projects', { name: 'Sales' }))).toBe(
            'The handle "sales" is taken by the archived project "Sales".',
        );
        expect((await call('PATCH', `/projects/${ops}`, { name: 'Vendas' })).body.handle).toBe('vendas');
    });

    test('folders: rename, move, archive, restore and delete on the branch; committed and read back with git', async () => {
        const { call, projectId, branch, show, tree, changes, contents, devTip } = await workspace();
        const dev = devTip();
        const later = (await call('POST', `/projects/${projectId}/folders`, { name: 'Later' })).body.id as string;
        expect((await call('POST', `/projects/${projectId}/flows`, { name: 'Restock', folderId: later })).status).toBe(201);
        const parent = (await call('POST', `/projects/${projectId}/folders`, { name: 'Parent' })).body.id as string;
        expect((await commitAll(call, 'Folders')).status).toBe(200);

        const renamed = await call('PATCH', `/folders/${later}`, { name: 'Soon' });
        expect(renamed.status).toBe(200);
        expect(renamed.body).toMatchObject({ name: 'Soon', parentId: null });
        const soon = renamed.body.id as string;
        expect(await changes()).toEqual(['projects/Sales/flows/Later/Restock.flow.yaml -> projects/Sales/flows/Soon/Restock.flow.yaml']);
        expect((await call('PATCH', `/folders/${soon}`, { name: 'parent' })).status).toBe(409);

        const moved = await call('POST', `/folders/${soon}/move`, { parentId: parent });
        expect(moved.status).toBe(200);
        expect(moved.body).toMatchObject({ name: 'Soon', parentId: parent });
        expect((await call('POST', `/folders/${parent}/move`, { parentId: moved.body.id })).status).toBe(400);
        const listed = await contents();
        expect(listed.folders).toEqual(['Parent', 'Soon']);
        expect(listed.body.flows.find((f: { name: string }) => f.name === 'Restock').folderId).toBe(moved.body.id);

        expect((await commitAll(call, 'Rename and move a folder')).status).toBe(200);
        expect(show(branch, 'projects/Sales/flows/Parent/Soon/Restock.flow.yaml')).toContain('id: ');
        expect(tree(branch).filter(path => path.includes('/Later/') || path.endsWith('Parent/.gitkeep'))).toEqual([]);
        expect(await changes()).toEqual([]);

        expect((await call('POST', `/folders/${parent}/archive`)).status).toBe(200);
        expect(await changes()).toEqual(['projects/Sales/flows/Parent/Soon/Restock.flow.yaml']);
        let now = await contents();
        expect(now.folders).toEqual([]);
        expect(now.archivedFolders).toEqual(['Parent', 'Soon']);
        expect(now.archivedFlows).toEqual(['Restock']);
        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect((await contents()).folders).toEqual(['Parent', 'Soon']);

        expect((await call('POST', `/folders/${parent}/archive`)).status).toBe(200);
        const back = await call('POST', `/folders/${parent}/restore`);
        expect(back.status).toBe(200);
        expect(back.body).toMatchObject({ id: parent, name: 'Parent', archivedAt: null });
        expect(await changes()).toEqual([]);
        expect((await contents()).flows).toEqual(['Orders', 'Restock']);

        expect((await call('POST', `/folders/${parent}/archive`)).status).toBe(200);
        expect((await commitAll(call, 'Archive Parent')).status).toBe(200);
        expect(tree(branch).filter(path => path.includes('/Parent/'))).toEqual([]);
        expect((await contents()).archivedFolders).toEqual(['Parent', 'Soon']);
        expect((await call('POST', `/folders/${parent}/restore`)).status).toBe(200);
        expect((await commitAll(call, 'Restore Parent')).status).toBe(200);
        expect(show(branch, 'projects/Sales/flows/Parent/Soon/Restock.flow.yaml')).toContain('id: ');

        expect((await call('POST', `/folders/${parent}/archive`)).status).toBe(200);
        const deleted = await call('DELETE', `/folders/${parent}`);
        expect(deleted.status).toBe(200);
        expect(deleted.body).toEqual({ id: parent, flows: 1 });
        now = await contents();
        expect(now.archivedFolders).toEqual([]);
        expect(now.archivedFlows).toEqual([]);
        expect(await changes()).toEqual(['projects/Sales/flows/Parent/Soon/Restock.flow.yaml']);
        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect((await contents()).folders).toEqual(['Parent', 'Soon']);
        expect(devTip()).toBe(dev);
    });

    test('flows: clone, restore and delete on the branch; committed and read back with git', async () => {
        const { call, orders, branch, show, tree, changes, contents, devTip } = await workspace();
        const dev = devTip();

        const cloned = await call('POST', `/flows/${orders}/clone`, { name: 'Orders copy' });
        expect(cloned.status).toBe(201);
        const copy = cloned.body.id as string;
        expect(await changes()).toEqual(['projects/Sales/flows/Orders copy.flow.yaml']);
        expect((await call('POST', `/flows/${orders}/clone`, { name: 'orders COPY' })).status).toBe(409);
        expect((await call('GET', `/flows/${copy}/draft`)).body.flow.nodes.map((n: { id: string }) => n.id)).toEqual(
            (await call('GET', `/flows/${orders}/draft`)).body.flow.nodes.map((n: { id: string }) => n.id),
        );
        expect((await commitAll(call, 'Clone')).status).toBe(200);
        expect(show(branch, 'projects/Sales/flows/Orders copy.flow.yaml')).toContain(`id: ${copy}`);
        expect(show(branch, 'projects/Sales/flows/Orders copy.flow.yaml')).not.toContain('deployed: true');

        expect((await call('POST', `/flows/${copy}/archive`)).status).toBe(200);
        expect((await contents()).archivedFlows).toEqual(['Orders copy']);
        expect((await call('POST', `/flows/${orders}/restore`)).status).toBe(404);
        const restored = await call('POST', `/flows/${copy}/restore`);
        expect(restored.status).toBe(200);
        expect(restored.body).toMatchObject({ id: copy, name: 'Orders copy', archivedAt: null });
        expect(await changes()).toEqual([]);

        expect((await call('POST', `/flows/${copy}/archive`)).status).toBe(200);
        expect((await commitAll(call, 'Archive the copy')).status).toBe(200);
        expect(tree(branch)).not.toContain('projects/Sales/flows/Orders copy.flow.yaml');
        expect((await call('POST', `/flows/${copy}/restore`)).status).toBe(200);
        expect(await changes()).toEqual(['projects/Sales/flows/Orders copy.flow.yaml']);
        expect((await commitAll(call, 'Restore the copy')).status).toBe(200);
        expect(show(branch, 'projects/Sales/flows/Orders copy.flow.yaml')).toContain(`id: ${copy}`);

        const third = (await call('POST', `/flows/${orders}/clone`, { name: 'Orders third' })).body.id as string;
        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect((await call('GET', `/flows/${third}`)).status).toBe(404);

        expect((await call('DELETE', `/flows/${copy}`)).status).toBe(409);
        expect((await call('POST', `/flows/${copy}/archive`)).status).toBe(200);
        expect((await call('DELETE', `/flows/${copy}`)).status).toBe(200);
        expect((await contents()).archivedFlows).toEqual([]);
        expect(await changes()).toEqual(['projects/Sales/flows/Orders copy.flow.yaml']);
        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect((await contents()).flows).toEqual(['Orders', 'Orders copy']);
        expect(devTip()).toBe(dev);
    });

    test('scripts: a move on the branch rewrites the imports; committed and read back with git, and discarded', async () => {
        const { call, projectId, branch, show, tree, changes, devTip } = await workspace();
        const dev = devTip();
        const create = (path: string, content: string) => call('POST', `/projects/${projectId}/scripts`, { path, kind: 'script', content });
        expect((await create('lib/util', 'export const n = 1;\n')).status).toBe(201);
        expect((await create('main', "import { n } from '@myproject/scripts/lib/util';\nexport const m = n;\n")).status).toBe(201);
        expect((await commitAll(call, 'Scripts')).status).toBe(200);

        expect((await call('POST', `/projects/${projectId}/scripts/move`, { from: 'lib', to: 'main' })).status).toBe(409);
        const moved = await call('POST', `/projects/${projectId}/scripts/move`, { from: 'lib', to: 'tools' });
        expect(moved.status).toBe(200);
        expect(await changes()).toEqual([
            'projects/Sales/scripts/lib/util.ts',
            'projects/Sales/scripts/main.ts',
            'projects/Sales/scripts/tools/util.ts',
        ]);
        const listed = (await call('GET', `/projects/${projectId}/scripts`)).body.scripts.map((s: { path: string }) => s.path);
        expect(listed).toEqual(['main', 'tools/util']);

        expect((await commitAll(call, 'Move lib')).status).toBe(200);
        expect(show(branch, 'projects/Sales/scripts/main.ts')).toContain("from '@myproject/scripts/tools/util'");
        expect(show(branch, 'projects/Sales/scripts/tools/util.ts')).toBe('export const n = 1;');
        expect(tree(branch)).not.toContain('projects/Sales/scripts/lib/util.ts');

        expect((await call('POST', `/projects/${projectId}/scripts/move`, { from: 'tools/util', to: 'util' })).status).toBe(200);
        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect(await changes()).toEqual([]);
        expect((await call('GET', `/projects/${projectId}/scripts`)).body.scripts.map((s: { path: string }) => s.path)).toEqual([
            'main',
            'tools/util',
        ]);
        expect(devTip()).toBe(dev);
    });

    test('connections: the declaration on the branch, the configuration in the environment at once', async () => {
        const { id, call, onDev, warehouse, branch, show, tree, changes, devTip } = await workspace();
        const dev = devTip();
        const names = async (user = ANA) =>
            ((await (user === ANA ? call : onDev)('GET', '/connections')).body.items as { name: string }[]).map(c => c.name);

        const shop = await call('POST', '/connections', { ...shopConnection, newSecrets: [] });
        expect(shop.status).toBe(201);
        expect(await changes()).toEqual(['connections/Shop.yaml']);
        expect(await names()).toEqual(['Shop', 'Warehouse']);
        expect(await names(BIA)).toEqual(['Warehouse']);
        const [kept] = await db.query<{ config: Record<string, string>; deleted_at: Date | null }>(
            'SELECT config, deleted_at FROM connections WHERE id = $1',
            [shop.body.id],
        );
        expect(kept!.config).toMatchObject({ bootstrapServers: 'b:9092' });
        expect(kept!.deleted_at).not.toBeNull();
        expect((await call('POST', '/connections', { ...shopConnection, name: 'shop', newSecrets: [] })).status).toBe(409);

        const renamed = await call('PUT', `/connections/${shop.body.id}`, {
            ...shopConnection,
            name: 'Shop 2',
            config: { ...shopConnection.config, bootstrapServers: 'c:9092' },
            newSecrets: [],
        });
        expect(renamed.status).toBe(200);
        expect(renamed.body).toMatchObject({ name: 'Shop 2', config: { bootstrapServers: 'c:9092' } });
        expect(await changes()).toEqual(['connections/Shop 2.yaml']);

        const moved = await call('PUT', `/connections/${warehouse}`, {
            ...shopConnection,
            name: 'Depot',
            config: { ...shopConnection.config, bootstrapServers: 'w:9092' },
            newSecrets: [],
        });
        expect(moved.status).toBe(200);
        expect(await names()).toEqual(['Depot', 'Shop 2']);
        const onDevNow = (await onDev('GET', '/connections')).body.items as { name: string; config: Record<string, string> }[];
        expect(onDevNow.map(c => [c.name, c.config.bootstrapServers])).toEqual([['Warehouse', 'w:9092']]);
        expect(
            (
                await call('PUT', `/connections/${warehouse}`, {
                    name: 'Depot',
                    type: 'rest-basic',
                    config: { user: 'u', password: 'kafka-pass' },
                    newSecrets: [],
                })
            ).status,
        ).toBe(409);

        expect((await commitAll(call, 'Connections')).status).toBe(200);
        expect(show(branch, 'connections/Shop 2.yaml')).toContain(`id: ${shop.body.id}`);
        expect(show(branch, 'connections/Depot.yaml')).toContain(`id: ${warehouse}`);
        expect(tree(branch).filter(path => path.startsWith('connections/'))).toEqual(['connections/Depot.yaml', 'connections/Shop 2.yaml']);
        expect(devTip()).toBe(dev);

        expect((await call('DELETE', `/connections/${warehouse}`)).status).toBe(200);
        expect(await changes()).toEqual(['connections/Depot.yaml']);
        expect(await names()).toEqual(['Shop 2']);
        expect(await names(BIA)).toEqual(['Warehouse']);
        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect(await names()).toEqual(['Depot', 'Shop 2']);

        const temp = (await call('POST', '/connections', { ...shopConnection, name: 'Temp', newSecrets: [] })).body.id as string;
        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect(await names()).toEqual(['Depot', 'Shop 2']);
        expect(
            await db.query('SELECT id FROM connections WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NOT NULL', [temp, id]),
        ).toHaveLength(1);
    });

    test('a project moves to another workspace from the environment only', async () => {
        const { call, projectId } = await workspace();
        const other = crypto.randomUUID();
        await insertWorkspace(db, other, 'other');
        const refused = await call('POST', `/projects/${projectId}/move`, { toWorkspace: slugOf(other) });
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toContain('Pick dev to move it.');
    });

    test("the MCP's create_project lands on the current branch", async () => {
        const { id, changes, projects } = await workspace();
        const { token } = newApiToken();
        await insertApiToken(db, { userId: ANA, name: 'test', token, scopes: API_SCOPES });
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
                fetch: (url, init) => Promise.resolve(app.request(String(url), init as RequestInit)),
            }),
        );
        const result = (await client.callTool({ name: 'create_project', arguments: { workspace: slugOf(id), name: 'Agents' } })) as {
            isError?: boolean;
            content: { text: string }[];
        };
        expect(result.isError).toBeFalsy();
        expect(await changes()).toEqual(['projects/Agents/project.yaml']);
        expect(await projects()).toEqual(['Agents', 'Sales']);
        expect(await projects('active', BIA)).toEqual(['Sales']);
        await client.close();
    });
});
