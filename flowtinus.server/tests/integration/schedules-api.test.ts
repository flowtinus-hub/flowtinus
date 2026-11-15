import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { openDatabase, type Database } from '#shared/database/database';
import { fireDueSchedules, timesToRun } from '#features/schedules/fire-schedules';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

type ScheduleBody = {
    id: string;
    cron: string;
    enabled: boolean;
    nextFireAt: string | null;
    lastError: string | null;
    last: { runId: string; status: string } | null;
};

describe('schedules', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let projectId: string;
    const workspaceId = crypto.randomUUID();
    const headers = { 'x-user-id': ANA, 'content-type': 'application/json' };
    const call = async (method: string, path: string, body?: unknown) => {
        const response = await app.request(wsPath(workspaceId, path), {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const fields = (more: Record<string, unknown> = {}) => ({ cron: '0 9 * * 1-5', timezone: 'America/Sao_Paulo', ...more });
    /** a flow whose Start has a parameter and takes an input, deployed */
    const deployedFlow = async (name: string) => {
        const id = (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
        const draft = (await call('GET', `/flows/${id}/draft`)).body as {
            revision: number;
            flow: { nodes: { type: string; config: Record<string, unknown> }[] };
        };
        const nodes = draft.flow.nodes.map(n =>
            n.type === 'start'
                ? {
                      ...n,
                      config: { parameters: [{ name: 'since', type: 'number', default: '1' }], acceptsInput: true, testInput: '[{"a":1}]' },
                  }
                : n,
        );
        expect((await call('PUT', `/flows/${id}/draft`, { revision: draft.revision, flow: { ...draft.flow, nodes } })).status).toBe(200);
        expect((await call('POST', `/flows/${id}/deploy`)).status).toBe(200);
        return id;
    };
    /** the schedule due at `at` (as if its time came) */
    const dueAt = (id: string, at: Date) => db.query('UPDATE flow_schedules SET next_fire_at = $2 WHERE id = $1', [id, at]);
    const runsOf = (scheduleId: string) =>
        db.query<{
            id: string;
            status: string;
            trigger: string;
            flow_version_id: string | null;
            scheduled_for: Date;
            input: unknown;
            parameters: unknown;
            error: string | null;
        }>(
            'SELECT id, status, trigger, flow_version_id, scheduled_for, input, parameters, error FROM runs WHERE schedule_id = $1 ORDER BY scheduled_for',
            [scheduleId],
        );

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId, 'acme');
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-schedules', '{default}', 1, 'test')`);
        app = createApp(db, 'DEV');
        projectId = (await call('POST', '/projects', { name: 'Schedules' })).body.id as string;
    });

    afterAll(async () => {
        await db.close();
    });

    test('only a deployed flow; the expression (5 or 6 fields) and the time zone checked; off has no next time; removed', async () => {
        const plain = (await call('POST', `/projects/${projectId}/flows`, { name: 'Not deployed' })).body.id as string;
        const refused = await call('POST', `/flows/${plain}/schedules`, fields());
        expect(refused.status).toBe(400);
        expect((refused.body.error as { message: string }).message).toContain('Deploy the flow first');

        const flowId = await deployedFlow('Nightly');
        const bad = await call('POST', `/flows/${flowId}/schedules`, fields({ cron: '61 * * * *' }));
        expect((bad.body.error as { fields: Record<string, string> }).fields).toEqual({ 'fields.cron': 'Invalid value for minute: 61' });
        const zone = await call('POST', `/flows/${flowId}/schedules`, fields({ timezone: 'Mars/Olympus' }));
        expect((zone.body.error as { fields: Record<string, string> }).fields).toEqual({
            'fields.timezone': 'Unknown time zone: Mars/Olympus.',
        });

        const created = await call('POST', `/flows/${flowId}/schedules`, fields({ cron: '30 * * * * *' }));
        expect(created.status).toBe(201);
        const schedule = created.body as unknown as ScheduleBody;
        expect(new Date(schedule.nextFireAt!).getUTCSeconds()).toBe(30);

        const off = (await call('PUT', `/schedules/${schedule.id}`, fields({ cron: '30 * * * * *', enabled: false })))
            .body as unknown as ScheduleBody;
        expect(off.nextFireAt).toBeNull();
        expect(((await call('GET', `/flows/${flowId}/schedules`)).body.items as ScheduleBody[]).map(s => s.id)).toEqual([schedule.id]);
        const listed = (await call('GET', `/projects/${projectId}/contents`)).body.flows as { id: string; schedules: unknown }[];
        expect(listed.find(f => f.id === flowId)!.schedules).toEqual({ total: 1, on: 0 });

        expect((await call('DELETE', `/schedules/${schedule.id}`)).status).toBe(200);
        expect((await call('GET', `/flows/${flowId}/schedules`)).body.items).toEqual([]);
    });

    test('its time comes: one run of the deployed version, with its parameters and the Start default input; then the next time', async () => {
        const flowId = await deployedFlow('Hourly');
        const schedule = (
            await call('POST', `/flows/${flowId}/schedules`, fields({ cron: '0 * * * *', timezone: 'UTC', parameters: { since: '7' } }))
        ).body as unknown as ScheduleBody;
        const at = new Date('2026-11-07T10:00:00Z');
        await dueAt(schedule.id, at);

        const fired = await fireDueSchedules(db, new Date('2026-11-07T10:00:02Z'));
        expect(fired.runs.map(r => r.status)).toEqual(['queued']);
        const [run] = await runsOf(schedule.id);
        expect(run).toMatchObject({ status: 'queued', trigger: 'schedule', parameters: { since: '7' }, input: [{ a: 1 }] });
        expect(run!.flow_version_id).not.toBeNull();
        expect(new Date(run!.scheduled_for).toISOString()).toBe(at.toISOString());

        const after = ((await call('GET', `/flows/${flowId}/schedules`)).body.items as ScheduleBody[])[0]!;
        expect(after.nextFireAt).toBe('2026-11-07T11:00:00.000Z');
        expect(after.last).toMatchObject({ runId: run!.id, status: 'queued' });

        // the same moment again (another supervisor): nothing more
        expect((await fireDueSchedules(db, new Date('2026-11-07T10:00:03Z'))).runs).toEqual([]);

        // its time again while that run still waits: skipped, and shown with why
        await fireDueSchedules(db, new Date('2026-11-07T11:00:01Z'));
        const [, skipped] = await runsOf(schedule.id);
        expect(skipped).toMatchObject({ status: 'skipped', error: `Skipped: its previous run (${run!.id}) was still running.` });
    });

    test('not deployed anymore: no run, the schedule says why; no worker for its tag: a failed run', async () => {
        const flowId = await deployedFlow('Undeployed');
        const schedule = (await call('POST', `/flows/${flowId}/schedules`, fields({ cron: '0 * * * *', timezone: 'UTC' })))
            .body as unknown as ScheduleBody;
        await call('POST', `/flows/${flowId}/undeploy`);
        await dueAt(schedule.id, new Date('2026-11-07T10:00:00Z'));
        await fireDueSchedules(db, new Date('2026-11-07T10:00:01Z'));
        expect(await runsOf(schedule.id)).toEqual([]);
        expect(((await call('GET', `/flows/${flowId}/schedules`)).body.items as ScheduleBody[])[0]!.lastError).toBe(
            'The flow is not deployed.',
        );

        await call('POST', `/flows/${flowId}/deploy`);
        await call('PUT', `/flows/${flowId}/worker-tag`, { workerTag: 'nobody' });
        await dueAt(schedule.id, new Date('2026-11-07T11:00:00Z'));
        await fireDueSchedules(db, new Date('2026-11-07T11:00:01Z'));
        const [failed] = await runsOf(schedule.id);
        expect(failed).toMatchObject({ status: 'failed' });
        expect(failed!.error).toContain('nobody');
    });

    test('missed times (the supervisors were down), as Hangfire: once, each one, or none', async () => {
        const flowId = await deployedFlow('Missed');
        const make = async (misfire: string) =>
            (
                (await call('POST', `/flows/${flowId}/schedules`, fields({ cron: '0 * * * *', timezone: 'UTC', misfire })))
                    .body as unknown as ScheduleBody
            ).id;
        const [relaxed, strict, ignorable] = [await make('relaxed'), await make('strict'), await make('ignorable')];
        for (const id of [relaxed, strict, ignorable]) {
            await dueAt(id, new Date('2026-11-07T06:00:00Z'));
        }
        // down from 06:00 to 09:30: 06, 07, 08 and 09 were missed
        await fireDueSchedules(db, new Date('2026-11-07T09:30:00Z'));
        expect((await runsOf(relaxed)).map(r => [r.status, new Date(r.scheduled_for).toISOString()])).toEqual([
            ['queued', '2026-11-07T09:00:00.000Z'],
        ]);
        // strict: each one (the first queued, the others skipped while it waits)
        expect((await runsOf(strict)).map(r => r.status)).toEqual(['queued', 'skipped', 'skipped', 'skipped']);
        expect(await runsOf(ignorable)).toEqual([]);
    });

    test('which times run (unit)', () => {
        const t = (iso: string) => new Date(`2026-11-07T${iso}Z`);
        const now = t('10:00:30');
        expect(timesToRun([t('10:00:00')], now, 'ignorable')).toEqual([t('10:00:00')]);
        expect(timesToRun([t('08:00:00'), t('09:00:00'), t('10:00:00')], now, 'relaxed')).toEqual([t('10:00:00')]);
        expect(timesToRun([t('08:00:00'), t('09:00:00')], now, 'relaxed')).toEqual([t('09:00:00')]);
        expect(timesToRun([t('08:00:00'), t('09:00:00')], now, 'ignorable')).toEqual([]);
    });
});
