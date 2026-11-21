import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoFlowFromYaml, repoFlowToYaml } from '@flowtinus/core';
import { ANA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(60_000);

type Mode = 'direct' | 'pull-request' | 'protected';

function commitSchedule(repo: string, scheduleId: string) {
    const names = git(repo, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'dev').split('\n');
    const files = Object.fromEntries(
        names.map(path => [path, Bun.spawnSync(['git', 'show', `dev:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString()]),
    );
    const path = names.find(name => name.endsWith('/Orders.flow.yaml'))!;
    const read = repoFlowFromYaml(files[path]!, 'Orders');
    if (!read.ok) {
        throw new Error('Orders is not valid');
    }
    const schedules = [{ id: scheduleId, cron: '0 6 * * *', timezone: 'UTC', misfire: 'relaxed' as const, parameters: {} }];
    commitFiles(repo, 'dev', { ...files, [path]: repoFlowToYaml(read.value.flow, { ...read.value, schedules }) }, 'A schedule');
}

describe("the Schedules and Webhooks windows edit the flow's file on the current branch, and the environment's values on its branch", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace(mode: Mode = 'direct') {
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
            commitFiles(repo, 'flowtinus/config', { 'topology.yaml': topology.replace('mode: direct', `mode: ${mode}`) }, mode);
            expect((await call('POST', '/git/reconcile')).status).toBe(200);
        }
        await app.gitPoller.poll(id);
        const ordersPath = `${slugOf(id)}/projects/Sales/flows/Orders.flow.yaml`;
        const committed = (ref = 'dev') => {
            const read = repoFlowFromYaml(show(ref, ordersPath), 'Orders');
            return read.ok ? { schedules: read.value.schedules, webhooks: read.value.webhooks } : read;
        };
        const triggers = async () => (await call('GET', `/flows/${orders}/triggers`)).body;
        const handle = async () => (await call('GET', '/me')).body.handle as string;
        return { call, projectId, orders, repo, committed, triggers, handle };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-git-trigger-windows', '{default}', 1, 'test')`);
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-trigger-windows-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test("on the environment's branch a schedule added goes into the file's working copy; committed, it arrives disabled with its environment values", async () => {
        const { call, orders, committed, triggers } = await workspace();

        const added = await call('POST', `/flows/${orders}/triggers/schedules`, { cron: '0 6 * * *', timezone: 'UTC' });
        expect(added.status).toBe(201);
        const s = added.body.id as string;
        expect(added.body).toEqual({ id: s, cron: '0 6 * * *', timezone: 'UTC', misfire: 'relaxed', parameters: {} });

        expect(await triggers()).toEqual({
            file: { editable: true },
            schedules: [{ id: s, cron: '0 6 * * *', timezone: 'UTC', misfire: 'relaxed', parameters: {} }],
            webhooks: [],
            environment: { schedules: [], webhooks: [] },
        });
        expect(committed()).toEqual({ schedules: [], webhooks: [] });

        expect((await commitAll(call, 'A schedule')).status).toBe(200);
        expect(committed()).toEqual({
            schedules: [{ id: s, cron: '0 6 * * *', timezone: 'UTC', misfire: 'relaxed', parameters: {} }],
            webhooks: [],
        });
        const after = await triggers();
        expect(after.schedules.map((x: { id: string }) => x.id)).toEqual([s]);
        expect(after.environment.schedules).toEqual([expect.objectContaining({ id: s, enabled: false, arrivedDisabled: true })]);
    });

    test("the canvas' Commit of a flow whose file only gained a trigger commits it and answers it as arrived disabled", async () => {
        const { call, orders, committed } = await workspace();
        const w = (await call('POST', `/flows/${orders}/triggers/webhooks`, { name: 'Shop' })).body.id as string;
        expect((await call('GET', `/flows/${orders}/deployments`)).body.triggersChanged).toBe(true);

        const deployed = await call('POST', `/flows/${orders}/deploy`, { message: 'A webhook' });
        expect(deployed.body.triggersChanged).toBeUndefined();
        expect(deployed.status).toBe(200);
        expect(committed()).toEqual({ schedules: [], webhooks: [{ id: w, name: 'Shop', response: 'async' }] });
        expect(deployed.body.arrived).toEqual([
            expect.objectContaining({ flowId: orders, schedules: [], webhooks: [expect.objectContaining({ id: w, tokenHint: null })] }),
        ]);
    });

    test('a webhook is added, changed and removed in the file; a trigger not in the file is not found; a cron not valid is refused', async () => {
        const { call, orders, triggers } = await workspace();
        const w = (await call('POST', `/flows/${orders}/triggers/webhooks`, { name: 'Shop' })).body.id as string;
        const changed = await call('PUT', `/flows/${orders}/triggers/webhooks/${w}`, { name: 'Store', response: 'wait' });
        expect(changed.status).toBe(200);
        expect((await triggers()).webhooks).toEqual([{ id: w, name: 'Store', response: 'wait' }]);

        const s = (await call('POST', `/flows/${orders}/triggers/schedules`, { cron: '0 6 * * *', timezone: 'UTC' })).body.id;
        const edited = await call('PUT', `/flows/${orders}/triggers/schedules/${s}`, {
            cron: '30 7 * * *',
            timezone: 'Europe/Lisbon',
            misfire: 'strict',
            parameters: { since: '2' },
            input: [1],
        });
        expect(edited.status).toBe(200);
        expect((await triggers()).schedules).toEqual([
            { id: s, cron: '30 7 * * *', timezone: 'Europe/Lisbon', misfire: 'strict', parameters: { since: '2' }, input: [1] },
        ]);

        const refused = await call('PUT', `/flows/${orders}/triggers/schedules/${s}`, { cron: 'every day', timezone: 'UTC' });
        expect(refused.status).toBe(400);
        expect(Object.keys(refused.body.error.fields)).toEqual(['fields.cron']);
        expect((await call('PUT', `/flows/${orders}/triggers/schedules/${w}`, { cron: '0 6 * * *', timezone: 'UTC' })).status).toBe(404);
        expect((await call('DELETE', `/flows/${orders}/triggers/webhooks/${s}`)).status).toBe(404);

        expect((await call('DELETE', `/flows/${orders}/triggers/webhooks/${w}`)).status).toBe(200);
        expect((await call('DELETE', `/flows/${orders}/triggers/schedules/${s}`)).status).toBe(200);
        expect(await triggers()).toMatchObject({ schedules: [], webhooks: [] });
    });

    test("on a work branch the file's triggers are edited in its working copy and committed to it; no environment values there", async () => {
        const { call, orders, committed, triggers, handle } = await workspace();
        const branch = `users/${await handle()}/triggers`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);

        const w = (await call('POST', `/flows/${orders}/triggers/webhooks`, { name: 'Shop' })).body.id as string;
        expect(await triggers()).toEqual({
            file: { editable: true },
            schedules: [],
            webhooks: [{ id: w, name: 'Shop', response: 'async' }],
            environment: null,
        });

        const { flow, revision } = (await call('GET', `/flows/${orders}/draft`)).body;
        const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label: 'Begin' } : n));
        expect((await call('PUT', `/flows/${orders}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);

        expect((await commitAll(call, 'A webhook')).status).toBe(200);
        expect(committed(branch)).toEqual({ schedules: [], webhooks: [{ id: w, name: 'Shop', response: 'async' }] });
        expect(committed()).toEqual({ schedules: [], webhooks: [] });
        expect((await call('GET', `/flows/${orders}/webhooks`)).body.items).toEqual([]);
    });

    test('pull-request: an edit of the file is refused, offering a branch; the switch and the overrides stay editable', async () => {
        const { call, orders, repo, triggers } = await workspace('pull-request');
        const s = crypto.randomUUID();
        commitSchedule(repo, s);
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');

        expect((await triggers()).file).toEqual({ editable: false, offersBranch: true });
        const refused = await call('POST', `/flows/${orders}/triggers/schedules`, { cron: '0 6 * * *', timezone: 'UTC' });
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toBe('dev only takes pull requests: create a branch of your own to make changes.');

        expect((await call('PUT', `/schedules/${s}/enabled`, { enabled: true })).status).toBe(200);
        expect((await call('PUT', `/schedules/${s}/overrides`, { cron: '0 * * * *' })).status).toBe(200);
        expect((await triggers()).environment.schedules).toEqual([
            expect.objectContaining({ id: s, enabled: true, overrides: { cron: '0 * * * *', parameters: {} } }),
        ]);
    });

    test("protected: the file's triggers are read only; the switch and the overrides stay editable", async () => {
        const { call, orders, repo, triggers } = await workspace('protected');
        const s = crypto.randomUUID();
        commitSchedule(repo, s);
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');

        const message = "This server's environment is protected: the triggers in the flow's file are read only here.";
        expect((await triggers()).file).toEqual({ editable: false, readOnly: message });
        for (const [method, path, body] of [
            ['POST', `/flows/${orders}/triggers/webhooks`, { name: 'Shop' }],
            ['PUT', `/flows/${orders}/triggers/schedules/${s}`, { cron: '0 7 * * *', timezone: 'UTC' }],
            ['DELETE', `/flows/${orders}/triggers/schedules/${s}`, undefined],
        ] as const) {
            expect((await call(method, path, body)).body.error).toEqual({ code: 'conflict', message });
        }

        expect((await call('PUT', `/schedules/${s}/enabled`, { enabled: true })).status).toBe(200);
        expect((await call('PUT', `/schedules/${s}/overrides`, { timezone: 'Europe/Lisbon' })).status).toBe(200);
        expect((await triggers()).schedules).toEqual([{ id: s, cron: '0 6 * * *', timezone: 'UTC', misfire: 'relaxed', parameters: {} }]);
    });

    test("duplicating a flow gives its triggers new ids, on the environment's branch and on a work branch", async () => {
        const { call, orders, handle } = await workspace();
        const triggersOf = async (flowId: string) => (await call('GET', `/flows/${flowId}/triggers`)).body;
        const s = (
            await call('POST', `/flows/${orders}/triggers/schedules`, { cron: '0 6 * * *', timezone: 'UTC', parameters: { a: '1' } })
        ).body.id as string;
        const w = (await call('POST', `/flows/${orders}/triggers/webhooks`, { name: 'Shop', response: 'wait' })).body.id as string;

        const copied = async (name: string) => {
            const copy = await call('POST', `/flows/${orders}/clone`, { name });
            expect(copy.status).toBe(201);
            const { schedules, webhooks } = await triggersOf(copy.body.id);
            expect(schedules).toEqual([
                { id: expect.any(String), cron: '0 6 * * *', timezone: 'UTC', misfire: 'relaxed', parameters: { a: '1' } },
            ]);
            expect(webhooks).toEqual([{ id: expect.any(String), name: 'Shop', response: 'wait' }]);
            expect([schedules[0].id, webhooks[0].id]).not.toContain(s);
            expect([schedules[0].id, webhooks[0].id]).not.toContain(w);
            expect(schedules[0].id).toMatch(/^[0-9a-f-]{36}$/);
        };
        await copied('Orders copy');
        expect((await commitAll(call, 'Copies')).status).toBe(200);

        expect((await call('POST', '/git/branches', { name: `users/${await handle()}/copies` })).status).toBe(201);
        await copied('Orders copy 2');
        expect((await commitAll(call, 'Copies on a branch')).status).toBe(200);
    });

    test('with git on, the old create, change and delete of a schedule or webhook are refused: they are in the file', async () => {
        const { call, orders, repo } = await workspace();
        const s = crypto.randomUUID();
        commitSchedule(repo, s);
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');

        const message = "Git is on: a flow's schedules and webhooks are changed in its file, then committed.";
        for (const [method, path, body] of [
            ['POST', `/flows/${orders}/schedules`, { cron: '0 6 * * *', timezone: 'UTC' }],
            ['PUT', `/schedules/${s}`, { cron: '0 7 * * *', timezone: 'UTC' }],
            ['DELETE', `/schedules/${s}`, undefined],
            ['POST', `/flows/${orders}/webhooks`, { name: 'Shop' }],
            ['PUT', `/webhooks/${crypto.randomUUID()}`, { name: 'Shop' }],
            ['DELETE', `/webhooks/${crypto.randomUUID()}`, undefined],
        ] as const) {
            expect({ path, error: (await call(method, path, body)).body.error }).toEqual({ path, error: { code: 'conflict', message } });
        }
        expect((await call('GET', `/flows/${orders}/schedules`)).body.items).toEqual([
            expect.objectContaining({ id: s, cron: '0 6 * * *' }),
        ]);
    });
});
