import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectionToYaml, GITATTRIBUTES, projectToYaml, repoFlowToYaml, workspaceToYaml, type FlowFile, type FlowFileNode } from '@flowtinus/core';
import { git } from '../helpers/git-repos';
import { ANA } from '../helpers/workspaces';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { DiskPoller } from '#features/git/disk-poller';
import { gitOptions } from '#features/git/git-config';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

const at = (x: number) => ({ x, y: 0 });

const logFlow = (id: string, message: string): FlowFile => {
    const nodes: FlowFileNode[] = [{ id: 'log', type: 'log', position: at(100), config: { message } }];
    return {
        version: 1,
        id,
        name: '',
        nodes: [
            { id: 'start', type: 'start', position: at(0), config: {} },
            ...nodes,
            { id: 'end', type: 'end', position: at(900), config: {} },
        ],
        edges: [
            { source: 'start', sourcePort: 'out-0', target: 'log', targetPort: 'in-0' },
            { source: 'log', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        ],
    };
};

describe('a local server reconciles the disk', () => {
    let db: Database;
    let dir: string;
    let repo: string;
    let app: ReturnType<typeof createApp>;
    let poller: DiskPoller;
    let clock = 0;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);
    const ids = { sales: crypto.randomUUID(), orders: crypto.randomUUID() };
    const paths = {
        workspace: 'sales/workspace.yaml',
        project: 'sales/projects/Sales/project.yaml',
        orders: 'sales/projects/Sales/flows/Orders.flow.yaml',
        prices: 'sales/projects/Sales/scripts/lib/prices.ts',
    };

    const write = (files: Record<string, string>) => {
        for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(repo, path)), { recursive: true });
            writeFileSync(join(repo, path), text);
        }
    };
    const remove = (path: string) => rmSync(join(repo, path), { recursive: true, force: true });
    const writeTree = (message = 'v1') =>
        write({
            '.gitattributes': GITATTRIBUTES,
            [paths.workspace]: workspaceToYaml(),
            [paths.project]: projectToYaml({ id: ids.sales, description: 'Money in', icon: 'cart', color: 'green' }),
            [paths.orders]: repoFlowToYaml(logFlow(ids.orders, message)),
            [paths.prices]: `export const price = '${message}';`,
        });

    const settle = async () => {
        await poller.tick();
        clock += 1000;
        return poller.tick();
    };

    const call = async (method: string, path: string, body?: unknown) => {
        const response = await app.request(path, {
            method,
            headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as any };
    };
    const versions = async () =>
        (await call('GET', `/w/sales/flows/${ids.orders}/deployments`)).body.versions.map(
            (v: { number: number; commit: string | null; definition: FlowFile }) => ({
                number: v.number,
                commit: v.commit,
                message: v.definition.nodes.find(n => n.id === 'log')!.config.message,
            }),
        );

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-disk-reconcile-'));
        repo = join(dir, 'flows');
        mkdirSync(repo);
        git(repo, 'init', '--quiet', '--initial-branch=main');
        db = await openDatabase('memory://');
        await db.query('INSERT INTO users (id, name, email, is_admin) VALUES ($1, $2, $3, true)', [ANA, 'Ana', 'ana@example.com']);
        const options = gitOptions('LOCAL', { clonesDir: join(dir, 'clones'), localRepo: repo });
        app = createApp(db, 'LOCAL', keyring, undefined, { git: options });
        clock = 0;
        poller = new DiskPoller(db, options, keyring, undefined, () => clock);
    });

    afterEach(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a valid tree is applied with no sha: its workspace made, versions from disk, the deploy on them', async () => {
        writeTree();
        expect(await settle()).toBe('reconciled');

        expect((await call('GET', '/workspaces')).body.items).toEqual([expect.objectContaining({ handle: 'sales', role: 'admin' })]);
        expect(await versions()).toEqual([{ number: 1, commit: null, message: 'v1' }]);
        const { history } = (await call('GET', `/w/sales/flows/${ids.orders}/deployments`)).body;
        expect(history).toEqual([expect.objectContaining({ action: 'deploy', toNumber: 1, commit: null })]);
        expect((await call('GET', '/w/sales/git/status')).body).toMatchObject({
            on: false,
            disk: { refused: null, gone: null, appliedAt: expect.any(String) },
        });

        const prices = async () => (await call('GET', `/w/sales/projects/${ids.sales}/scripts/content?path=lib/prices`)).body.content;
        expect(await prices()).toBe("export const price = 'v1';");

        writeTree('v2');
        expect(await settle()).toBe('reconciled');
        expect(await versions()).toEqual([
            { number: 2, commit: null, message: 'v2' },
            { number: 1, commit: null, message: 'v1' },
        ]);
        expect(await prices()).toBe("export const price = 'v2';");
    });

    test('a change is reconciled once the disk has been quiet for a second, not before; an unchanged disk not again', async () => {
        writeTree();
        expect(await poller.tick()).toBe('settling');
        clock += 600;
        writeTree('v1, still writing');
        expect(await poller.tick()).toBe('settling');
        clock += 600;
        expect(await poller.tick()).toBe('settling');
        expect((await call('GET', '/workspaces')).body.items).toEqual([]);

        clock += 400;
        expect(await poller.tick()).toBe('reconciled');
        expect(await versions()).toEqual([{ number: 1, commit: null, message: 'v1, still writing' }]);

        clock += 1000;
        expect(await poller.tick()).toBe('unchanged');
        write({ 'notes.txt': 'not a file of a workspace' });
        expect(await settle()).toBe('reconciled');
        expect(await versions()).toHaveLength(1);
    });

    test('an invalid tree is refused whole, with its errors per file, while the last valid one keeps running', async () => {
        writeTree();
        await settle();
        const { appliedAt } = (await call('GET', '/w/sales/git/status')).body.disk;

        write({
            [paths.orders]: '<<<<<<< HEAD\nnodes: []\n=======\n>>>>>>> theirs\n',
            'sales/projects/Sales/flows/New.flow.yaml': 'id: [',
        });
        expect(await settle()).toBe('reconciled');
        const refused = (await call('GET', '/w/sales/git/status')).body.disk;
        expect(refused).toMatchObject({ appliedAt, gone: null });
        expect(refused.refused.errors.map((e: { path: string }) => e.path)).toEqual(
            expect.arrayContaining([paths.orders, 'sales/projects/Sales/flows/New.flow.yaml']),
        );
        expect(await versions()).toEqual([{ number: 1, commit: null, message: 'v1' }]);

        clock += 1000;
        expect(await poller.tick()).toBe('unchanged');
        write({ 'sales/projects/Sales/flows/New.flow.yaml': 'id: [[' });
        expect(await settle()).toBe('reconciled');
        expect((await call('GET', '/w/sales/git/status')).body.disk.refused.since).toBe(refused.refused.since);

        remove('sales/projects/Sales/flows/New.flow.yaml');
        writeTree('v2');
        expect(await settle()).toBe('reconciled');
        expect((await call('GET', '/w/sales/git/status')).body.disk).toMatchObject({ refused: null });
        expect(await versions()).toEqual([
            { number: 2, commit: null, message: 'v2' },
            { number: 1, commit: null, message: 'v1' },
        ]);
    });

    test('a checkout out and back: the connection archived, then back configured; the schedule back disabled', async () => {
        const [events, schedule] = [crypto.randomUUID(), crypto.randomUUID()];
        const connection = 'sales/connections/Events.yaml';
        writeTree();
        write({
            [connection]: connectionToYaml({ id: events, type: 'kafka' }),
            [paths.orders]: repoFlowToYaml(logFlow(ids.orders, 'v1'), {
                schedules: [{ id: schedule, cron: '0 6 * * *', timezone: 'UTC', misfire: 'relaxed', parameters: {} }],
                webhooks: [],
            }),
        });
        git(repo, 'add', '.');
        git(repo, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '--quiet', '-m', 'main');
        git(repo, 'checkout', '--quiet', '-b', 'bare');
        git(repo, 'rm', '--quiet', connection);
        writeTree();
        git(repo, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '--quiet', '-am', 'bare');
        git(repo, 'checkout', '--quiet', 'main');
        await settle();

        const config = { bootstrapServers: 'b:9092', security: 'SASL_SSL', mechanism: 'PLAIN', user: 'u', password: 'kafka-pass' };
        await call('POST', '/w/sales/secrets', { name: 'kafka-pass', value: 's3cret' });
        expect((await call('PUT', `/w/sales/connections/${events}`, { name: 'Events', type: 'kafka', config })).status).toBe(200);
        expect((await call('PUT', `/w/sales/schedules/${schedule}/enabled`, { enabled: true })).status).toBe(200);

        git(repo, 'checkout', '--quiet', 'bare');
        clock += 1000;
        expect(await settle()).toBe('reconciled');
        expect((await call('GET', '/w/sales/git/archived-connections')).body.items).toEqual([expect.objectContaining({ id: events })]);
        expect((await call('GET', `/w/sales/flows/${ids.orders}/schedules`)).body.items).toEqual([]);

        git(repo, 'checkout', '--quiet', 'main');
        clock += 1000;
        expect(await settle()).toBe('reconciled');
        expect((await call('GET', '/w/sales/git/archived-connections')).body.items).toEqual([]);
        expect((await call('GET', '/w/sales/connections')).body.items).toEqual([
            expect.objectContaining({ id: events, name: 'Events', config: expect.objectContaining(config) }),
        ]);
        expect((await call('GET', `/w/sales/flows/${ids.orders}/schedules`)).body.items).toEqual([
            expect.objectContaining({ id: schedule, enabled: false, arrivedDisabled: true }),
        ]);
    });

    test("the editor's Run runs the disk as it is, reconciled at once; an invalid disk is refused, with its errors", async () => {
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-disk', '{default}', 1, 'test')`);
        writeTree();
        await settle();

        writeTree('v2');
        const run = await call('POST', `/w/sales/flows/${ids.orders}/runs`, { mode: 'validation' });
        expect(run.status).toBe(202);
        expect(await versions()).toEqual([
            { number: 2, commit: null, message: 'v2' },
            { number: 1, commit: null, message: 'v1' },
        ]);

        write({ [paths.orders]: 'id: [' });
        const refused = await call('POST', `/w/sales/flows/${ids.orders}/runs`, { mode: 'validation' });
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toContain('The disk is not valid');
        expect(refused.body.error.message).toContain(paths.orders);
    });

    test('a file renamed only in case on disk, not in git, is a warning on it; renamed with git mv, it is not', async () => {
        const renamed = 'sales/projects/Sales/flows/ORDERS.flow.yaml';
        const commit = () => git(repo, '-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '--quiet', '-m', 'files');
        writeTree();
        git(repo, 'add', '.');
        commit();
        await settle();
        expect((await call('GET', '/w/sales/git/status')).body.disk.warnings).toEqual([]);

        renameSync(join(repo, paths.orders), join(repo, renamed));
        write({ [paths.prices]: "export const price = 'v2';" });
        clock += 1000;
        expect(await settle()).toBe('reconciled');
        expect((await call('GET', '/w/sales/git/status')).body.disk.warnings).toEqual([
            { path: renamed, message: `renamed only in case on disk; git still has \`${paths.orders}\`: use \`git mv\`` },
        ]);

        renameSync(join(repo, renamed), join(repo, paths.orders));
        git(repo, 'mv', paths.orders, renamed);
        commit();
        clock += 1000;
        expect(await settle()).toBe('reconciled');
        expect((await call('GET', '/w/sales/git/status')).body.disk.warnings).toEqual([]);
    });

    test('a workspace folder that leaves the disk is gone, not deleted, and is no longer reconciled; back, it is again', async () => {
        writeTree();
        write({ 'books/workspace.yaml': workspaceToYaml() });
        await settle();
        expect((await call('GET', '/workspaces')).body.items.map((w: { handle: string }) => w.handle)).toEqual(['books', 'sales']);

        remove('sales');
        clock += 1000;
        expect(await settle()).toBe('reconciled');
        expect((await call('GET', '/workspaces')).body.items).toEqual([
            expect.objectContaining({ handle: 'books', gone: null }),
            expect.objectContaining({ handle: 'sales', gone: expect.any(String) }),
        ]);
        expect((await call('GET', '/w/sales/git/status')).body.disk.gone).toEqual(expect.any(String));
        expect(await versions()).toEqual([{ number: 1, commit: null, message: 'v1' }]);
        expect((await call('GET', `/w/sales/projects/${ids.sales}/contents`)).body.flows).toEqual([
            expect.objectContaining({ id: ids.orders, deployedVersion: 1 }),
        ]);

        writeTree('v2');
        clock += 1000;
        expect(await settle()).toBe('reconciled');
        expect((await call('GET', '/w/sales/git/status')).body.disk.gone).toBeNull();
        expect(await versions()).toHaveLength(2);
    });
});
