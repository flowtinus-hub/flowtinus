import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GITATTRIBUTES, projectToYaml, repoFlowFromYaml, repoFlowToYaml, workspaceToYaml, type FlowFile, type RepoSchedule, type RepoWebhook } from '@flowtinus/core';
import { ANA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, git } from '../helpers/git-repos';
import { fireDueSchedules } from '#features/schedules/fire-schedules';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

const at = (x: number) => ({ x, y: 0 });

const logFlow = (id: string, message: string): FlowFile => ({
    version: 1,
    id,
    name: '',
    nodes: [
        { id: 'start', type: 'start', position: at(0), config: {} },
        { id: 'log', type: 'log', position: at(100), config: { message } },
        { id: 'end', type: 'end', position: at(900), config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'log', targetPort: 'in-0' },
        { source: 'log', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

const schedule = (id: string, cron = '0 6 * * *'): RepoSchedule => ({ id, cron, timezone: 'UTC', misfire: 'relaxed', parameters: {} });
const webhook = (id: string, name = 'Shop'): RepoWebhook => ({ id, name, response: 'async' });

type Files = Record<string, string>;
type Triggers = { schedules?: RepoSchedule[]; webhooks?: RepoWebhook[]; deployed?: boolean };

describe('the reconcile applies the schedules and webhooks in the flow files; what it creates or brings back arrives disabled', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace(triggers: Triggers = {}) {
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
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);

        const ids = { sales: crypto.randomUUID(), orders: crypto.randomUUID() };
        const p = (path: string) => `${slug}/${path}`;
        const paths = { project: p('projects/Sales/project.yaml'), orders: p('projects/Sales/flows/Orders.flow.yaml') };
        const ordersFile = (with_: Triggers) => repoFlowToYaml(logFlow(ids.orders, 'v1'), with_);
        commitFiles(repo, 'dev', {
            '.gitattributes': GITATTRIBUTES,
            [p('workspace.yaml')]: workspaceToYaml(),
            [paths.project]: projectToYaml({ id: ids.sales, description: 'Money in', icon: 'cart', color: 'green' }),
            [paths.orders]: ordersFile(triggers),
        });
        expect((await call('POST', '/git/on', {})).status).toBe(200);

        const onBranch = (): Files => {
            const names = git(repo, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'dev').split('\n');
            const show = (path: string) => Bun.spawnSync(['git', 'show', `dev:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
            return Object.fromEntries(names.map(path => [path, show(path)]));
        };
        const commitOrders = async (with_: Triggers) => {
            commitFiles(repo, 'dev', { ...onBranch(), [paths.orders]: ordersFile(with_) }, 'by hand');
            const reconciled = await call('POST', '/git/reconcile');
            expect(reconciled.body.outcome).toBe('applied');
            return reconciled;
        };
        const schedules = async () => (await call('GET', `/flows/${ids.orders}/schedules`)).body.items;
        const webhooks = async () => (await call('GET', `/flows/${ids.orders}/webhooks`)).body.items;
        const arrived = async () => (await call('GET', '/git/arrived-disabled')).body.items;
        return { id, call, repo, ids, paths, onBranch, commitOrders, schedules, webhooks, arrived };
    }

    const hook = async (id: string, token: string) =>
        (await app.request(`/wh/${id}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status;

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-git-triggers', '{default}', 1, 'test')`);
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-triggers-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a schedule and a webhook committed arrive disabled, the webhook with no token, and are listed by flow', async () => {
        const { ids, commitOrders, schedules, webhooks, arrived } = await newWorkspace();
        const [s, w] = [crypto.randomUUID(), crypto.randomUUID()];
        await commitOrders({ schedules: [schedule(s)], webhooks: [webhook(w)] });

        expect(await schedules()).toEqual([
            expect.objectContaining({ id: s, cron: '0 6 * * *', timezone: 'UTC', enabled: false, nextFireAt: null, arrivedDisabled: true }),
        ]);
        expect(await webhooks()).toEqual([
            expect.objectContaining({ id: w, name: 'Shop', enabled: false, tokenHint: null, arrivedDisabled: true }),
        ]);
        expect(await arrived()).toEqual([
            {
                flowId: ids.orders,
                flowName: 'Orders',
                projectId: ids.sales,
                schedules: [expect.objectContaining({ id: s })],
                webhooks: [expect.objectContaining({ id: w })],
            },
        ]);
    });

    test("a Commit's outcome lists the triggers it brought that arrived disabled, by flow, not those already waiting", async () => {
        const { id, call, ids, paths, commitOrders } = await newWorkspace();
        const [waiting, s, w] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
        await commitOrders({ schedules: [schedule(waiting)] });
        const { flow, revision } = (await call('GET', `/flows/${ids.orders}/draft`)).body;
        const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label: 'Begin' } : n));
        expect((await call('PUT', `/flows/${ids.orders}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
        const [row] = await db.query<{ content: string }>('SELECT content FROM working_copy WHERE workspace_id = $1 AND path = $2', [
            id,
            paths.orders,
        ]);
        const read = repoFlowFromYaml(row!.content, 'Orders');
        if (!read.ok) {
            throw new Error('The working copy holds no flow.');
        }
        const text = repoFlowToYaml(read.value.flow, {
            ...read.value,
            schedules: [schedule(waiting), schedule(s)],
            webhooks: [webhook(w)],
        });
        await db.query('UPDATE working_copy SET content = $3 WHERE workspace_id = $1 AND path = $2', [id, paths.orders, text]);

        const committed = await commitAll(call, 'A schedule and a webhook');

        expect(committed.status).toBe(200);
        expect(committed.body.arrived).toEqual([
            {
                flowId: ids.orders,
                flowName: 'Orders',
                projectId: ids.sales,
                schedules: [expect.objectContaining({ id: s, enabled: false, arrivedDisabled: true })],
                webhooks: [expect.objectContaining({ id: w, enabled: false, arrivedDisabled: true })],
            },
        ]);
    });

    test('turned on, a schedule fires and a webhook answers with the token made then, shown once; neither is listed anymore', async () => {
        const { call, commitOrders, schedules, webhooks, arrived } = await newWorkspace();
        const [s, w] = [crypto.randomUUID(), crypto.randomUUID()];
        await commitOrders({ schedules: [schedule(s, '0 * * * *')], webhooks: [webhook(w)] });

        const on = await call('PUT', `/schedules/${s}/enabled`, { enabled: true });
        expect(on.status).toBe(200);
        expect(on.body).toMatchObject({ id: s, enabled: true, arrivedDisabled: false });
        expect(on.body.nextFireAt).not.toBeNull();
        await db.query("UPDATE flow_schedules SET next_fire_at = '2026-11-07T10:00:00Z' WHERE id = $1", [s]);
        const fired = await fireDueSchedules(db, new Date('2026-11-07T10:00:02Z'));
        expect(fired.runs).toEqual([expect.objectContaining({ scheduleId: s, status: 'queued' })]);

        const hookOn = await call('PUT', `/webhooks/${w}/enabled`, { enabled: true });
        expect(hookOn.status).toBe(200);
        const { webhook: view, token } = hookOn.body;
        expect(token).toMatch(/^dfwh_/);
        expect(view).toMatchObject({ id: w, enabled: true, arrivedDisabled: false, tokenHint: token.slice(0, 9) });
        expect(await hook(w, token)).toBe(202);

        expect((await call('PUT', `/webhooks/${w}/enabled`, { enabled: false })).body.token).toBeUndefined();
        expect(await hook(w, token)).toBe(404);
        const again = await call('PUT', `/webhooks/${w}/enabled`, { enabled: true });
        expect(again.body.token).toBeUndefined();
        expect(await hook(w, token)).toBe(202);

        expect((await schedules())[0].enabled).toBe(true);
        expect((await webhooks())[0].enabled).toBe(true);
        expect(await arrived()).toEqual([]);
    });

    test('a schedule changed in git is updated and keeps its enabled; no new flow version and no deployment line', async () => {
        const { call, ids, commitOrders, schedules, webhooks } = await newWorkspace();
        const [s, w] = [crypto.randomUUID(), crypto.randomUUID()];
        await commitOrders({ schedules: [schedule(s, '0 6 * * *')], webhooks: [webhook(w)] });
        await call('PUT', `/schedules/${s}/enabled`, { enabled: true });
        await call('PUT', `/webhooks/${w}/enabled`, { enabled: true });
        const before = (await call('GET', `/flows/${ids.orders}/deployments`)).body;

        await commitOrders({ schedules: [{ ...schedule(s, '30 7 * * *'), parameters: { since: '2' } }], webhooks: [webhook(w, 'Store')] });

        const [changed] = await schedules();
        expect(changed).toMatchObject({ id: s, cron: '30 7 * * *', parameters: { since: '2' }, enabled: true, arrivedDisabled: false });
        expect(new Date(changed.nextFireAt).getUTCMinutes()).toBe(30);
        expect(await webhooks()).toEqual([expect.objectContaining({ id: w, name: 'Store', enabled: true, arrivedDisabled: false })]);
        const after = (await call('GET', `/flows/${ids.orders}/deployments`)).body;
        expect(after.versions).toHaveLength(before.versions.length);
        expect(after.history).toHaveLength(before.history.length);
    });

    test('a trigger removed in git is archived and off; brought back, it arrives disabled again with its token', async () => {
        const { call, commitOrders, schedules, webhooks, arrived } = await newWorkspace();
        const [s, w] = [crypto.randomUUID(), crypto.randomUUID()];
        await commitOrders({ schedules: [schedule(s)], webhooks: [webhook(w)] });
        await call('PUT', `/schedules/${s}/enabled`, { enabled: true });
        const { token } = (await call('PUT', `/webhooks/${w}/enabled`, { enabled: true })).body;

        await commitOrders({});
        expect(await schedules()).toEqual([]);
        expect(await webhooks()).toEqual([]);
        expect(await hook(w, token)).toBe(404);
        expect((await call('PUT', `/webhooks/${w}/enabled`, { enabled: true })).status).toBe(404);

        await commitOrders({ schedules: [schedule(s)], webhooks: [webhook(w)] });
        expect(await schedules()).toEqual([expect.objectContaining({ id: s, enabled: false, nextFireAt: null, arrivedDisabled: true })]);
        expect(await webhooks()).toEqual([
            expect.objectContaining({ id: w, enabled: false, arrivedDisabled: true, tokenHint: token.slice(0, 9) }),
        ]);
        expect((await arrived()).map((a: { flowName: string }) => a.flowName)).toEqual(['Orders']);
        expect(await hook(w, token)).toBe(404);

        expect((await call('PUT', `/webhooks/${w}/enabled`, { enabled: true })).body.token).toBeUndefined();
        expect(await hook(w, token)).toBe(202);
    });

    test("deployed: false turns the flow's triggers off; deploying it again turns nothing on", async () => {
        const { call, commitOrders, schedules, webhooks } = await newWorkspace();
        const [s, w] = [crypto.randomUUID(), crypto.randomUUID()];
        const triggers = { schedules: [schedule(s)], webhooks: [webhook(w)] };
        await commitOrders(triggers);
        await call('PUT', `/schedules/${s}/enabled`, { enabled: true });
        await call('PUT', `/webhooks/${w}/enabled`, { enabled: true });

        await commitOrders({ ...triggers, deployed: false });
        expect(await schedules()).toEqual([expect.objectContaining({ id: s, enabled: false, nextFireAt: null })]);
        expect(await webhooks()).toEqual([expect.objectContaining({ id: w, enabled: false })]);
        expect((await call('PUT', `/schedules/${s}/enabled`, { enabled: true })).status).toBe(400);

        await commitOrders(triggers);
        expect(await schedules()).toEqual([expect.objectContaining({ id: s, enabled: false })]);
        expect(await webhooks()).toEqual([expect.objectContaining({ id: w, enabled: false })]);
    });

    test('a webhook id another workspace on this server uses refuses the commit, saying so', async () => {
        const w = crypto.randomUUID();
        await (await newWorkspace()).commitOrders({ webhooks: [webhook(w)] });
        const { call, repo, ids, paths, onBranch, webhooks } = await newWorkspace();
        commitFiles(repo, 'dev', { ...onBranch(), [paths.orders]: repoFlowToYaml(logFlow(ids.orders, 'v1'), { webhooks: [webhook(w)] }) });

        const refused = await call('POST', '/git/reconcile');
        expect(refused.body).toMatchObject({
            outcome: 'refused',
            errors: [{ path: paths.orders, message: `The webhook id "${w}" is already used by another workspace on this server.` }],
        });
        expect(await webhooks()).toEqual([]);
    });

    const runsOf = (scheduleId: string) =>
        db.query<{ scheduled_for: Date; parameters: unknown; input: unknown }>(
            'SELECT scheduled_for, parameters, input FROM runs WHERE schedule_id = $1 ORDER BY scheduled_for',
            [scheduleId],
        );

    test("a schedule fires with git's values under this environment's overrides; its view gives both", async () => {
        const { call, commitOrders, schedules } = await newWorkspace();
        const s = crypto.randomUUID();
        await commitOrders({ schedules: [{ ...schedule(s, '0 6 * * *'), parameters: { since: '1', limit: '5' } }] });

        const overridden = await call('PUT', `/schedules/${s}/overrides`, { cron: '0 * * * *', parameters: { since: '9' } });
        expect(overridden.status).toBe(200);
        expect(overridden.body).toMatchObject({
            id: s,
            cron: '0 6 * * *',
            parameters: { since: '1', limit: '5' },
            overrides: { cron: '0 * * * *', parameters: { since: '9' } },
            effective: { cron: '0 * * * *', timezone: 'UTC', parameters: { since: '9', limit: '5' } },
        });
        expect(overridden.body.overrides.timezone).toBeUndefined();
        expect(overridden.body.overrides.input).toBeUndefined();

        await call('PUT', `/schedules/${s}/enabled`, { enabled: true });
        await db.query("UPDATE flow_schedules SET next_fire_at = '2026-11-07T10:00:00Z' WHERE id = $1", [s]);
        const fired = await fireDueSchedules(db, new Date('2026-11-07T10:00:02Z'));
        expect(fired.runs).toEqual([expect.objectContaining({ scheduleId: s, status: 'queued' })]);
        expect(await runsOf(s)).toEqual([
            { scheduled_for: new Date('2026-11-07T10:00:00Z'), parameters: { since: '9', limit: '5' }, input: null },
        ]);
        expect((await schedules())[0].nextFireAt).toEqual('2026-11-07T11:00:00.000Z');
    });

    test("an override survives a commit that changes the same field, giving git's new value; it is never written to git", async () => {
        const { call, ids, paths, onBranch, commitOrders, schedules } = await newWorkspace();
        const s = crypto.randomUUID();
        await commitOrders({ schedules: [{ ...schedule(s, '0 6 * * *'), parameters: { since: '1' } }] });
        await call('PUT', `/schedules/${s}/overrides`, { cron: '15 * * * *', timezone: 'Europe/Lisbon', parameters: { since: '9' } });
        await call('PUT', `/schedules/${s}/enabled`, { enabled: true });

        await commitOrders({ schedules: [{ ...schedule(s, '30 7 * * *'), timezone: 'America/New_York', parameters: { since: '2' } }] });

        const [changed] = await schedules();
        expect(changed).toMatchObject({
            cron: '30 7 * * *',
            timezone: 'America/New_York',
            parameters: { since: '2' },
            enabled: true,
            overrides: { cron: '15 * * * *', timezone: 'Europe/Lisbon', parameters: { since: '9' } },
            effective: { cron: '15 * * * *', timezone: 'Europe/Lisbon', parameters: { since: '9' } },
        });
        expect(new Date(changed.nextFireAt).getUTCMinutes()).toBe(15);

        expect((await call('PATCH', `/flows/${ids.orders}`, { name: 'Sales orders' })).status).toBe(200);
        expect((await call('POST', `/flows/${ids.orders}/deploy`)).status).toBe(200);
        const file = onBranch()[paths.orders.replace('Orders.flow.yaml', 'Sales orders.flow.yaml')]!;
        const read = repoFlowFromYaml(file, 'Sales orders');
        expect(read.ok && read.value.schedules).toEqual([
            { ...schedule(s, '30 7 * * *'), timezone: 'America/New_York', parameters: { since: '2' } },
        ]);
    });

    test("an override cleared by hand, field by field, brings git's value back and the next time with it", async () => {
        const { call, commitOrders } = await newWorkspace();
        const s = crypto.randomUUID();
        await commitOrders({ schedules: [{ ...schedule(s, '0 6 * * *'), parameters: { since: '1', limit: '5' } }] });
        await call('PUT', `/schedules/${s}/overrides`, { cron: '15 * * * *', parameters: { since: '9', limit: '7' }, input: [1] });
        await call('PUT', `/schedules/${s}/enabled`, { enabled: true });

        const cleared = await call('PUT', `/schedules/${s}/overrides`, { cron: null, parameters: { since: null }, input: null });
        expect(cleared.status).toBe(200);
        expect(cleared.body.overrides).toEqual({ parameters: { limit: '7' } });
        expect(cleared.body.effective).toEqual({ cron: '0 6 * * *', timezone: 'UTC', parameters: { since: '1', limit: '7' } });
        expect(new Date(cleared.body.nextFireAt).getUTCHours()).toBe(6);
        expect(new Date(cleared.body.nextFireAt).getUTCMinutes()).toBe(0);
    });

    test("an override can say no input, firing without git's input; null clears it back to git's", async () => {
        const { call, commitOrders } = await newWorkspace();
        const s = crypto.randomUUID();
        await commitOrders({ schedules: [{ ...schedule(s), input: [1] }] });

        expect((await call('PUT', `/schedules/${s}/overrides`, { noInput: true, input: [2] })).status).toBe(400);
        const none = await call('PUT', `/schedules/${s}/overrides`, { noInput: true });
        expect(none.status).toBe(200);
        expect(none.body.input).toEqual([1]);
        expect(none.body.overrides).toEqual({ noInput: true, parameters: {} });
        expect(none.body.effective).toEqual({ cron: '0 6 * * *', timezone: 'UTC', parameters: {} });

        await call('PUT', `/schedules/${s}/enabled`, { enabled: true });
        await db.query("UPDATE flow_schedules SET next_fire_at = '2026-11-07T06:00:00Z' WHERE id = $1", [s]);
        await fireDueSchedules(db, new Date('2026-11-07T06:00:02Z'));
        expect(await runsOf(s)).toEqual([expect.objectContaining({ input: null })]);

        const valued = await call('PUT', `/schedules/${s}/overrides`, { input: [2] });
        expect(valued.body.overrides).toEqual({ input: [2], parameters: {} });
        expect((await call('PUT', `/schedules/${s}/overrides`, { noInput: true })).body.overrides).toEqual({
            noInput: true,
            parameters: {},
        });

        const cleared = await call('PUT', `/schedules/${s}/overrides`, { input: null });
        expect(cleared.body.overrides).toEqual({ parameters: {} });
        expect(cleared.body.effective).toEqual({ cron: '0 6 * * *', timezone: 'UTC', parameters: {}, input: [1] });
    });

    test('an override that does not make a valid schedule, or of misfire, is refused; archived, it is not found', async () => {
        const { call, commitOrders } = await newWorkspace();
        const s = crypto.randomUUID();
        await commitOrders({ schedules: [schedule(s)] });

        expect((await call('PUT', `/schedules/${s}/overrides`, { cron: 'every day' })).status).toBe(400);
        expect((await call('PUT', `/schedules/${s}/overrides`, { timezone: 'Mars/Olympus' })).status).toBe(400);
        expect((await call('PUT', `/schedules/${s}/overrides`, { misfire: 'strict' })).status).toBe(400);

        await commitOrders({});
        expect((await call('PUT', `/schedules/${s}/overrides`, { cron: '0 * * * *' })).status).toBe(404);
    });

    test("the triggers stay in the flow's file through a canvas save and a rename, each committed by the app", async () => {
        const { call, ids, paths, onBranch, commitOrders } = await newWorkspace();
        const triggers = { schedules: [schedule(crypto.randomUUID())], webhooks: [webhook(crypto.randomUUID())] };
        await commitOrders(triggers);
        const inFile = (text: string | undefined) => {
            const read = repoFlowFromYaml(text ?? '', 'Orders');
            return read.ok ? { schedules: read.value.schedules, webhooks: read.value.webhooks } : read;
        };

        const { flow, revision } = (await call('GET', `/flows/${ids.orders}/draft`)).body;
        const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label: 'Begin' } : n));
        expect((await call('PUT', `/flows/${ids.orders}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
        expect((await call('POST', `/flows/${ids.orders}/deploy`)).status).toBe(200);
        expect(onBranch()[paths.orders]).toContain('label: Begin');
        expect(inFile(onBranch()[paths.orders])).toEqual(triggers);

        expect((await call('PATCH', `/flows/${ids.orders}`, { name: 'Sales orders' })).status).toBe(200);
        expect((await call('POST', `/flows/${ids.orders}/deploy`)).status).toBe(200);
        const renamed = paths.orders.replace('Orders.flow.yaml', 'Sales orders.flow.yaml');
        expect(onBranch()[paths.orders]).toBeUndefined();
        expect(inFile(onBranch()[renamed])).toEqual(triggers);
    });
});
