import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, BIA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { carryOverDrafts } from '#features/git/draft-carryover';
import { createApp } from '../../api/app';

setDefaultTimeout(60_000);

const shopConnection = {
    name: 'Shop',
    type: 'kafka',
    config: { bootstrapServers: 'b:9092', security: 'SASL_SSL', mechanism: 'PLAIN', user: 'u', password: 'kafka-pass' },
    newSecrets: [{ name: 'kafka-pass', value: 's3cret' }],
};

type Change = {
    path: string;
    from?: string;
    change: string;
    mine: boolean;
    editedByName?: string;
    requires: { path: string; reason: string }[];
};

describe("the working copy of the environment's branch", () => {
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

        const slug = slugOf(id);
        const at = (path: string) => `${slug}/${path}`;
        const tip = () => git(repo, 'rev-parse', 'dev');
        const lastMessage = () => git(repo, 'log', '-1', '--format=%s', 'dev');
        const tree = () =>
            git(repo, 'ls-tree', '-r', '--name-only', 'dev')
                .split('\n')
                .filter(p => p.startsWith(`${slug}/`) && !p.endsWith('workspace.yaml'))
                .map(p => p.slice(slug.length + 1));
        const show = (path: string) => git(repo, 'show', `dev:${at(path)}`);
        const changes = async (): Promise<Change[]> => {
            const answer = await call('GET', '/git/changes');
            expect(answer.status).toBe(200);
            return (answer.body.changes as Change[]).map(c => ({
                ...c,
                path: c.path.slice(slug.length + 1),
                ...(c.from ? { from: c.from.slice(slug.length + 1) } : {}),
            }));
        };
        const relabel = async (flowId: string, label: string) => {
            const { flow, revision } = (await call('GET', `/flows/${flowId}/draft`)).body;
            const nodes = flow.nodes.map((n: { id: string }) => (n.id === 'start' ? { ...n, label } : n));
            expect((await call('PUT', `/flows/${flowId}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
        };
        return { id, as, call, projectId, orders, at, tip, lastMessage, tree, show, changes, relabel };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-working-copy-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('an edit, a rename, a folder and a connection stay uncommitted, then go in one commit', async () => {
        const { call, projectId, orders, at, tip, lastMessage, tree, show, changes, relabel } = await workspace();
        const before = tip();

        await relabel(orders, 'Begin');
        expect((await call('PATCH', `/flows/${orders}`, { name: 'Big orders' })).status).toBe(200);
        expect((await call('POST', `/projects/${projectId}/folders`, { name: 'Later' })).status).toBe(201);
        const shop = await call('POST', '/connections', shopConnection);
        expect(shop.status).toBe(201);
        expect(tip()).toBe(before);

        expect((await changes()).map(({ path, from, change, mine }) => ({ path, from, change, mine }))).toEqual([
            { path: 'connections/Shop.yaml', from: undefined, change: 'added', mine: true },
            {
                path: 'projects/Sales/flows/Big orders.flow.yaml',
                from: 'projects/Sales/flows/Orders.flow.yaml',
                change: 'renamed',
                mine: true,
            },
            { path: 'projects/Sales/flows/Later/.gitkeep', from: undefined, change: 'added', mine: true },
        ]);

        const committed = await call('POST', '/git/commit', {
            paths: (await changes()).map(c => at(c.path)),
            message: 'Rename Orders, with a folder and a connection',
        });
        expect(committed.status).toBe(200);
        expect(lastMessage()).toBe('Rename Orders, with a folder and a connection');
        expect(tree()).toEqual([
            'connections/Shop.yaml',
            'projects/Sales/flows/Big orders.flow.yaml',
            'projects/Sales/flows/Later/.gitkeep',
            'projects/Sales/project.yaml',
        ]);
        expect(show('projects/Sales/flows/Big orders.flow.yaml')).toContain('label: Begin');
        expect(await changes()).toEqual([]);
        expect((await call('GET', `/flows/${orders}/draft`)).body.flow.name).toBe('Big orders');
        expect((await call('GET', `/flows/${orders}/deployments`)).body.versions).toHaveLength(2);
    });

    test("a partial Commit: one's own checked, a teammate's shown with its editor; what the files need comes along, with the reason", async () => {
        const { as, call, orders, at, tree, changes, relabel } = await workspace();
        const bia = as(BIA);
        const ops = (await call('POST', '/projects', { name: 'Ops' })).body.id as string;
        const restock = (await call('POST', `/projects/${ops}/flows`, { name: 'Restock' })).body.id as string;
        await relabel(restock, 'Count');
        const { flow, revision } = (await bia('GET', `/flows/${orders}/draft`)).body;
        expect(
            (
                await bia('PUT', `/flows/${orders}/draft`, {
                    revision,
                    flow: { ...flow, nodes: flow.nodes.map((n: { id: string }) => (n.id === 'end' ? { ...n, label: 'Bia' } : n)) },
                })
            ).status,
        ).toBe(200);

        const listed = await changes();
        expect(listed.map(({ path, change, mine, editedByName, requires }) => ({ path, change, mine, editedByName, requires }))).toEqual([
            {
                path: 'projects/Ops/flows/Restock.flow.yaml',
                change: 'added',
                mine: true,
                editedByName: 'Ana',
                requires: [{ path: at('projects/Ops/project.yaml'), reason: 'The new project Ops' }],
            },
            { path: 'projects/Ops/project.yaml', change: 'added', mine: true, editedByName: 'Ana', requires: [] },
            { path: 'projects/Sales/flows/Orders.flow.yaml', change: 'modified', mine: false, editedByName: 'Bia', requires: [] },
        ]);

        expect(
            (await call('POST', '/git/commit', { paths: [at('projects/Ops/flows/Restock.flow.yaml')], message: 'Restock' })).status,
        ).toBe(200);
        expect(tree()).toEqual([
            'projects/Ops/flows/Restock.flow.yaml',
            'projects/Ops/project.yaml',
            'projects/Sales/flows/Orders.flow.yaml',
            'projects/Sales/project.yaml',
        ]);
        expect((await changes()).map(c => c.path)).toEqual(['projects/Sales/flows/Orders.flow.yaml']);

        expect(
            (await call('POST', '/git/commit', { paths: [at('projects/Sales/flows/Orders.flow.yaml')], message: "Bia's end" })).status,
        ).toBe(200);
        expect(await changes()).toEqual([]);
    });

    test('discard: a rename goes back to its old path, an archive brings the flow back, a new connection is gone', async () => {
        const { call, orders, at, changes, relabel } = await workspace();
        expect((await call('PATCH', `/flows/${orders}`, { name: 'Renamed' })).status).toBe(200);
        expect((await call('POST', '/git/discard', { paths: [at('projects/Sales/flows/Renamed.flow.yaml')] })).status).toBe(200);
        expect((await call('GET', `/flows/${orders}/draft`)).body.flow.name).toBe('Orders');
        expect(await changes()).toEqual([]);

        expect((await call('POST', `/flows/${orders}/archive`)).status).toBe(200);
        expect((await changes()).map(c => [c.path, c.change])).toEqual([['projects/Sales/flows/Orders.flow.yaml', 'deleted']]);
        expect((await call('GET', `/flows/${orders}/deployments`)).body.deployed).not.toBeNull();
        expect((await call('POST', '/git/discard', { paths: [at('projects/Sales/flows/Orders.flow.yaml')] })).status).toBe(200);
        expect((await call('GET', `/flows/${orders}`)).body.archivedAt).toBeNull();

        const shop = (await call('POST', '/connections', shopConnection)).body.id;
        await relabel(orders, 'Mine');
        expect((await call('POST', '/git/discard', { mine: true })).status).toBe(200);
        expect(await changes()).toEqual([]);
        expect((await call('GET', '/connections')).body.items?.map((c: { id: string }) => c.id) ?? []).not.toContain(shop);
        expect(await db.query('SELECT id FROM connections WHERE id = $1', [shop])).toEqual([]);
        expect(
            (await call('GET', `/flows/${orders}/draft`)).body.flow.nodes.find((n: { id: string }) => n.id === 'start').label,
        ).toBeUndefined();
    });
    test('drafts and scripts being edited from before the working copy (migration 12) show as changes and outlive a discard of other files', async () => {
        const { id, call, projectId, orders, at, changes } = await workspace();
        const priceCheck = crypto.randomUUID();
        await db.query('INSERT INTO flows (id, workspace_id, project_id, name) VALUES ($1, $2, $3, $4)', [
            priceCheck,
            id,
            projectId,
            'Price check',
        ]);
        const { flow } = (await call('GET', `/flows/${orders}/draft`)).body;
        const labelled = (flowId: string, name: string, label: string) => ({
            revision: 4,
            flow: { ...flow, id: flowId, name, nodes: flow.nodes.map((n: { id: string }) => (n.id === 'start' ? { ...n, label } : n)) },
        });
        await db.exec(`CREATE TABLE draft_carryover (workspace_id uuid, flow_id uuid, draft jsonb, updated_by text);
          CREATE TABLE scripts_carryover (workspace_id uuid, project_id uuid, path text, content text, revision integer, updated_by text)`);
        for (const [flowId, name, label] of [
            [priceCheck, 'Price check', 'Mine'],
            [orders, 'Orders', 'Edited'],
        ] as const) {
            await db.query('INSERT INTO draft_carryover VALUES ($1, $2, $3::text::jsonb, $4)', [
                id,
                flowId,
                JSON.stringify(labelled(flowId, name, label)),
                ANA,
            ]);
        }
        await db.query('INSERT INTO scripts_carryover VALUES ($1, $2, $3, $4, 2, $5)', [
            id,
            projectId,
            'lib/legacy',
            'export const a = 1;\n',
            ANA,
        ]);
        await carryOverDrafts(db);

        expect((await changes()).map(c => [c.path, c.change])).toEqual([
            ['projects/Sales/flows/Orders.flow.yaml', 'modified'],
            ['projects/Sales/flows/Price check.flow.yaml', 'added'],
            ['projects/Sales/scripts/lib/legacy.ts', 'added'],
        ]);
        expect((await call('GET', `/flows/${priceCheck}/draft`)).body).toMatchObject({ revision: 4 });

        expect((await call('POST', `/projects/${projectId}/folders`, { name: 'Later' })).status).toBe(201);
        expect((await call('POST', '/git/discard', { paths: [at('projects/Sales/flows/Later/.gitkeep')] })).status).toBe(200);
        expect((await call('GET', `/flows/${priceCheck}`)).body.archivedAt).toBeNull();
        expect((await call('POST', '/git/reconcile')).status).toBe(200);
        expect((await call('GET', `/flows/${priceCheck}`)).body.archivedAt).toBeNull();
        expect((await changes()).map(c => c.path)).toEqual([
            'projects/Sales/flows/Orders.flow.yaml',
            'projects/Sales/flows/Price check.flow.yaml',
            'projects/Sales/scripts/lib/legacy.ts',
        ]);
        expect((await call('GET', `/flows/${orders}/draft`)).body.flow.nodes.find((n: { id: string }) => n.id === 'start').label).toBe(
            'Edited',
        );
    });
});
