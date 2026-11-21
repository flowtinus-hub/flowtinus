import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GITATTRIBUTES, projectToYaml, repoFlowFromYaml, repoFlowToYaml, workspaceToYaml, type FlowFile, type RepoSchedule, type RepoWebhook } from '@flowtinus/core';
import { ANA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { exportWorkspace } from '#features/git/workspace-export';
import { fireDueSchedules } from '#features/schedules/fire-schedules';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

const at = (x: number) => ({ x, y: 0 });

const logFlow = (id: string): FlowFile => ({
    version: 1,
    id,
    name: '',
    nodes: [
        { id: 'start', type: 'start', position: at(0), config: {} },
        { id: 'log', type: 'log', position: at(100), config: { message: 'v1' } },
        { id: 'end', type: 'end', position: at(900), config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'log', targetPort: 'in-0' },
        { source: 'log', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

const schedule = (id: string, cron = '0 6 * * *'): RepoSchedule => ({ id, cron, timezone: 'UTC', misfire: 'relaxed', parameters: {} });
const webhook = (id: string, name = 'Shop'): RepoWebhook => ({ id, name, response: 'async' });

describe('turning git on and off never starts or stops a trigger nobody saw', () => {
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

        const ordersPath = `${slug}/projects/Sales/flows/Orders.flow.yaml`;
        const deployedOrders = async () => {
            const sales = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
            const orders = (await call('POST', `/projects/${sales}/flows`, { name: 'Orders' })).body.id as string;
            expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
            return orders;
        };
        const newSchedule = async (flowId: string, fields: Record<string, unknown>) => {
            const created = await call('POST', `/flows/${flowId}/schedules`, { timezone: 'UTC', ...fields });
            expect(created.status).toBe(201);
            return created.body.id as string;
        };
        const newWebhook = async (flowId: string, name: string) => {
            const created = await call('POST', `/flows/${flowId}/webhooks`, { name });
            expect(created.status).toBe(201);
            return created.body as { webhook: { id: string }; token: string };
        };
        const onBranch = () => {
            const names = git(repo, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'dev').split('\n');
            const show = (path: string) => Bun.spawnSync(['git', 'show', `dev:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
            return Object.fromEntries(names.map(path => [path, show(path)])) as Record<string, string>;
        };
        const triggersInGit = () => {
            const read = repoFlowFromYaml(onBranch()[ordersPath] ?? '', 'Orders');
            return read.ok ? { schedules: read.value.schedules, webhooks: read.value.webhooks } : read;
        };
        const schedules = async (flowId: string) => (await call('GET', `/flows/${flowId}/schedules`)).body.items;
        const webhooks = async (flowId: string) => (await call('GET', `/flows/${flowId}/webhooks`)).body.items;
        const arrived = async () => (await call('GET', '/git/arrived-disabled')).body.items;
        return {
            id,
            slug,
            call,
            repo,
            config,
            ordersPath,
            deployedOrders,
            newSchedule,
            newWebhook,
            onBranch,
            triggersInGit,
            schedules,
            webhooks,
            arrived,
        };
    }

    const hook = async (id: string, token: string) =>
        (await app.request(`/wh/${id}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status;

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-git-turn-on-triggers', '{default}', 1, 'test')`);
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-turn-on-triggers-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('the first export writes each trigger with the values that run today; each keeps its enabled and its token', async () => {
        const { call, repo, deployedOrders, newSchedule, newWebhook, triggersInGit, schedules, webhooks, arrived } = await newWorkspace();
        createBranch(repo, 'dev');
        const orders = await deployedOrders();
        const daily = await newSchedule(orders, { cron: '0 6 * * *', parameters: { since: '1', limit: '5' } });
        const hourly = await newSchedule(orders, { cron: '0 * * * *', enabled: false });
        const { webhook: shop, token } = await newWebhook(orders, 'Shop');

        const on = await call('POST', '/git/on', {});
        expect(on.body).toMatchObject({ outcome: 'exported' });

        const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => (a.id < b.id ? -1 : 1));
        expect(triggersInGit()).toEqual({
            schedules: byId<RepoSchedule>([
                { id: daily, cron: '0 6 * * *', timezone: 'UTC', misfire: 'relaxed', parameters: { since: '1', limit: '5' } },
                { id: hourly, cron: '0 * * * *', timezone: 'UTC', misfire: 'relaxed', parameters: {} },
            ]),
            webhooks: [{ id: shop.id, name: 'Shop', response: 'async' }],
        });
        const listed = await schedules(orders);
        const of = (id: string) => listed.find((s: { id: string }) => s.id === id);
        expect(of(daily)).toMatchObject({ enabled: true, arrivedDisabled: false, overrides: { parameters: {} } });
        expect(new Date(of(daily).nextFireAt).getUTCHours()).toBe(6);
        expect(of(hourly)).toMatchObject({ enabled: false, arrivedDisabled: false });
        expect(await webhooks(orders)).toEqual([expect.objectContaining({ id: shop.id, enabled: true, arrivedDisabled: false })]);
        expect(await hook(shop.id, token)).toBe(202);
        expect(await arrived()).toEqual([]);
    });

    test('an import into an empty workspace brings every trigger disabled, listed as arrived; the preview says so', async () => {
        const { slug, call, repo, ordersPath, schedules, webhooks, arrived } = await newWorkspace();
        const ids = { sales: crypto.randomUUID(), orders: crypto.randomUUID(), s: crypto.randomUUID(), w: crypto.randomUUID() };
        commitFiles(repo, 'dev', {
            '.gitattributes': GITATTRIBUTES,
            [`${slug}/workspace.yaml`]: workspaceToYaml(),
            [`${slug}/projects/Sales/project.yaml`]: projectToYaml({ id: ids.sales, description: '' }),
            [ordersPath]: repoFlowToYaml(logFlow(ids.orders), { schedules: [schedule(ids.s)], webhooks: [webhook(ids.w)] }),
        });

        const plan = (await call('GET', '/git/on')).body;
        expect(plan).toMatchObject({ case: 'import', errors: [] });
        expect(plan.triggersToServer).toEqual([
            { kind: 'schedule', id: ids.s, path: ordersPath, change: 'arrives-disabled' },
            { kind: 'webhook', id: ids.w, path: ordersPath, change: 'arrives-disabled' },
        ]);

        expect((await call('POST', '/git/on', {})).body).toMatchObject({ outcome: 'imported' });
        expect(await schedules(ids.orders)).toEqual([
            expect.objectContaining({ id: ids.s, enabled: false, nextFireAt: null, arrivedDisabled: true }),
        ]);
        expect(await webhooks(ids.orders)).toEqual([
            expect.objectContaining({ id: ids.w, enabled: false, tokenHint: null, arrivedDisabled: true }),
        ]);
        expect((await arrived()).map((a: { flowId: string }) => a.flowId)).toEqual([ids.orders]);
    });
    test('git replaces the server: a trigger matched by id keeps its enabled, token and fires; a new one arrives disabled; one not in git is archived; the preview lists all three', async () => {
        const { id, call, repo, ordersPath, deployedOrders, newSchedule, newWebhook, onBranch, schedules, webhooks, arrived } =
            await newWorkspace();
        const orders = await deployedOrders();
        const kept = await newSchedule(orders, { cron: '0 6 * * *' });
        const gone = await newSchedule(orders, { cron: '0 * * * *' });
        const { webhook: shop, token } = await newWebhook(orders, 'Shop');
        await db.query("UPDATE flow_schedules SET next_fire_at = '2026-11-07T06:00:00Z' WHERE id = $1", [kept]);
        await fireDueSchedules(db, new Date('2026-11-07T06:00:01Z'));
        const firedBefore = (await schedules(orders)).find((s: { id: string }) => s.id === kept).last;
        expect(firedBefore).not.toBeNull();

        const [fresh, freshHook] = [crypto.randomUUID(), crypto.randomUUID()];
        const exported = await exportWorkspace(db, id);
        const read = repoFlowFromYaml(exported[ordersPath]!, 'Orders');
        if (!read.ok) {
            throw new Error(read.errors.join(' '));
        }
        commitFiles(repo, 'dev', {
            ...exported,
            [ordersPath]: repoFlowToYaml(read.value.flow, {
                ...read.value,
                schedules: [schedule(kept, '30 7 * * *'), schedule(fresh)],
                webhooks: [webhook(shop.id, 'Store'), webhook(freshHook)],
            }),
        });

        const plan = (await call('GET', '/git/on')).body;
        expect(plan).toMatchObject({ case: 'choice', errors: [] });
        const sorted = (list: { kind: string; id: string }[]) =>
            [...list].sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : 1)).map(({ kind, id }) => ({ kind, id }));
        const listed = (change: string) => sorted(plan.triggersToServer.filter((t: { change: string }) => t.change === change));
        expect(plan.triggersToServer.every((t: { path: string }) => t.path === ordersPath)).toBe(true);
        expect(listed('kept')).toEqual(
            sorted([
                { kind: 'schedule', id: kept },
                { kind: 'webhook', id: shop.id },
            ]),
        );
        expect(listed('arrives-disabled')).toEqual(
            sorted([
                { kind: 'schedule', id: fresh },
                { kind: 'webhook', id: freshHook },
            ]),
        );
        expect(listed('archived')).toEqual([{ kind: 'schedule', id: gone }]);

        expect((await call('POST', '/git/on', { choice: 'git' })).body).toMatchObject({ outcome: 'git-replaced-server' });
        const after = await schedules(orders);
        const of = (scheduleId: string) => after.find((s: { id: string }) => s.id === scheduleId);
        expect(of(kept)).toMatchObject({ cron: '30 7 * * *', enabled: true, arrivedDisabled: false, last: firedBefore });
        expect(new Date(of(kept).nextFireAt).getUTCMinutes()).toBe(30);
        expect(of(fresh)).toMatchObject({ enabled: false, nextFireAt: null, arrivedDisabled: true });
        expect(of(gone)).toBeUndefined();
        const hooks = await webhooks(orders);
        expect(hooks.find((w: { id: string }) => w.id === shop.id)).toMatchObject({ name: 'Store', enabled: true, arrivedDisabled: false });
        expect(hooks.find((w: { id: string }) => w.id === freshHook)).toMatchObject({
            enabled: false,
            tokenHint: null,
            arrivedDisabled: true,
        });
        expect(await hook(shop.id, token)).toBe(202);
        const [waiting] = await arrived();
        expect(
            sorted([
                ...waiting.schedules.map((s: { id: string }) => ({ kind: 'schedule', id: s.id })),
                ...waiting.webhooks.map((w: { id: string }) => ({ kind: 'webhook', id: w.id })),
            ]),
        ).toEqual(
            sorted([
                { kind: 'schedule', id: fresh },
                { kind: 'webhook', id: freshHook },
            ]),
        );
        expect(onBranch()[ordersPath]).toContain(fresh);
    });
    test("turning git off folds each schedule's overrides into its values; every trigger keeps its enabled", async () => {
        const { slug, call, repo, ordersPath, schedules, webhooks } = await newWorkspace();
        const ids = {
            sales: crypto.randomUUID(),
            orders: crypto.randomUUID(),
            s: crypto.randomUUID(),
            off: crypto.randomUUID(),
            w: crypto.randomUUID(),
        };
        commitFiles(repo, 'dev', {
            '.gitattributes': GITATTRIBUTES,
            [`${slug}/workspace.yaml`]: workspaceToYaml(),
            [`${slug}/projects/Sales/project.yaml`]: projectToYaml({ id: ids.sales, description: '' }),
            [ordersPath]: repoFlowToYaml(logFlow(ids.orders), {
                schedules: [{ ...schedule(ids.s, '0 6 * * *'), parameters: { since: '1', limit: '5' } }, schedule(ids.off)],
                webhooks: [webhook(ids.w)],
            }),
        });
        expect((await call('POST', '/git/on', {})).body).toMatchObject({ outcome: 'imported' });
        await call('PUT', `/schedules/${ids.s}/overrides`, {
            cron: '15 * * * *',
            timezone: 'Europe/Lisbon',
            parameters: { since: '9' },
            input: [1],
        });
        await call('PUT', `/schedules/${ids.s}/enabled`, { enabled: true });
        const { token } = (await call('PUT', `/webhooks/${ids.w}/enabled`, { enabled: true })).body;
        const before = (await schedules(ids.orders)).find((s: { id: string }) => s.id === ids.s);

        expect((await call('DELETE', '/git')).status).toBe(200);

        const after = await schedules(ids.orders);
        const folded = after.find((s: { id: string }) => s.id === ids.s);
        expect(folded).toMatchObject({
            cron: '15 * * * *',
            timezone: 'Europe/Lisbon',
            parameters: { since: '9', limit: '5' },
            input: [1],
            overrides: { parameters: {} },
            effective: before.effective,
            enabled: true,
            nextFireAt: before.nextFireAt,
        });
        expect(Object.keys(folded.overrides)).toEqual(['parameters']);
        expect(after.find((s: { id: string }) => s.id === ids.off)).toMatchObject({ cron: '0 6 * * *', enabled: false });
        expect(await webhooks(ids.orders)).toEqual([expect.objectContaining({ id: ids.w, enabled: true })]);
        expect(await hook(ids.w, token)).toBe(202);
    });

    test('with git off nothing has arrived disabled, and the environment overrides are refused', async () => {
        const { slug, call, repo, ordersPath, schedules, webhooks, arrived } = await newWorkspace();
        const ids = { sales: crypto.randomUUID(), orders: crypto.randomUUID(), s: crypto.randomUUID(), w: crypto.randomUUID() };
        commitFiles(repo, 'dev', {
            '.gitattributes': GITATTRIBUTES,
            [`${slug}/workspace.yaml`]: workspaceToYaml(),
            [`${slug}/projects/Sales/project.yaml`]: projectToYaml({ id: ids.sales, description: '' }),
            [ordersPath]: repoFlowToYaml(logFlow(ids.orders), { schedules: [schedule(ids.s)], webhooks: [webhook(ids.w)] }),
        });
        expect((await call('POST', '/git/on', {})).body).toMatchObject({ outcome: 'imported' });
        expect(await arrived()).toEqual([expect.objectContaining({ flowId: ids.orders })]);

        expect((await call('DELETE', '/git')).status).toBe(200);

        expect(await schedules(ids.orders)).toEqual([expect.objectContaining({ id: ids.s, enabled: false, arrivedDisabled: false })]);
        expect(await webhooks(ids.orders)).toEqual([expect.objectContaining({ id: ids.w, enabled: false, arrivedDisabled: false })]);
        expect((await call('GET', '/git/arrived-disabled')).status).toBe(409);
        expect((await call('PUT', `/schedules/${ids.s}/overrides`, { cron: '0 * * * *' })).status).toBe(409);

        const turnedOn = await call('PUT', `/webhooks/${ids.w}`, { name: 'Shop', enabled: true });
        expect(turnedOn.body).toEqual({ webhook: expect.objectContaining({ id: ids.w, enabled: true }), token: expect.any(String) });
        expect(await hook(ids.w, turnedOn.body.token)).toBe(202);
    });
});
