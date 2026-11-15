import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(90_000);

/*
 * Schedules as they run in production: two supervisor processes (supervisor/main.ts) on a real Postgres, started by
 * Testcontainers. Both fire the schedules that are due (FOR UPDATE SKIP LOCKED): each time of a schedule queues one run
 * (or one skipped run), never two, on time, whichever supervisor fires it; when one supervisor dies the other goes on;
 * times missed while none ran follow the schedule's misfire mode. Skipped when Docker is not running.
 */

const container: StartedPostgreSqlContainer | null = await new PostgreSqlContainer('postgres:17.6-alpine').start().catch(() => null);
const MAIN = fileURLToPath(new URL('../../supervisor/main.ts', import.meta.url));

type ScheduledRun = { id: string; status: string; scheduled_for: Date; queued_at: Date; worker_id: string | null; error: string | null };

describe.skipIf(!container)('schedules fired by supervisors on Postgres (separate processes)', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let projectId: string;
    const supervisors: ReturnType<typeof Bun.spawn>[] = [];
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

    /** a supervisor process; resolves once it says it is up (its id), its lines (one per run it fires) collected */
    const startSupervisor = async (): Promise<{ child: ReturnType<typeof Bun.spawn>; id: string; lines: string[] }> => {
        const child = Bun.spawn(['bun', MAIN], {
            env: {
                ...process.env,
                DATABASE_URL: container!.getConnectionUri(),
                WORKERS: '2',
                WORKER_TAGS: 'default',
                ENVIRONMENT: 'DEV',
                LOG_FORMAT: 'pretty',
                SECRETS_KEYS: `t:${Buffer.alloc(32, 9).toString('base64')}`,
            },
            stdout: 'pipe',
            stderr: 'inherit',
        });
        supervisors.push(child);
        const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
        const lines: string[] = [];
        let text = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                throw new Error(`the supervisor ended: ${text}`);
            }

            text += value;
            const id = /supervisor (\S+):/.exec(text)?.[1];
            if (id) {
                // keep reading its lines, so its output never blocks
                void (async () => {
                    for (;;) {
                        const next = await reader.read();
                        if (next.done) {
                            return;
                        }

                        lines.push(...next.value.split('\n').filter(Boolean));
                    }
                })();
                return { child, id, lines };
            }
        }
    };

    /** SIGTERM, as in production; one that has not ended 10 s later is killed, so a stuck stop fails fast, not at the timeout */
    const stop = async (child: ReturnType<typeof Bun.spawn>) => {
        child.kill('SIGTERM');
        const ended = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
        if (!ended) {
            child.kill('SIGKILL');
            await child.exited;
            throw new Error('the supervisor did not stop within 10 s of SIGTERM');
        }
    };

    /** a deployed flow (Start → End: it ends at once) */
    const deployedFlow = async (name: string) => {
        const id = (await call('POST', `/projects/${projectId}/flows`, { name })).body.id as string;
        expect((await call('POST', `/flows/${id}/deploy`)).status).toBe(200);
        return id;
    };

    const runsOf = (scheduleId: string) =>
        db.query<ScheduledRun>(
            'SELECT id, status, scheduled_for, queued_at, worker_id, error FROM runs WHERE schedule_id = $1 ORDER BY scheduled_for',
            [scheduleId],
        );

    const turnOff = (scheduleId: string, cron: string) =>
        call('PUT', `/schedules/${scheduleId}`, { cron, timezone: 'UTC', enabled: false });

    const until = async (check: () => Promise<boolean>, timeoutMs = 30_000) => {
        const deadline = Date.now() + timeoutMs;
        while (!(await check())) {
            if (Date.now() > deadline) {
                throw new Error('timed out');
            }

            await Bun.sleep(100);
        }
    };

    beforeAll(async () => {
        db = await openDatabase(container!.getConnectionUri());
        await insertWorkspace(db, workspaceId, 'acme');
        app = createApp(db, 'DEV');
        projectId = (await call('POST', '/projects', { name: 'Schedules' })).body.id as string;
    });

    afterAll(async () => {
        // SIGKILL: a graceful stop is what the tests check, not the cleanup (a stuck one would hold the hook until its timeout)
        for (const child of supervisors) {
            child.kill('SIGKILL');
        }

        await Promise.all(supervisors.map(child => child.exited));
        await db?.close();
        await container?.stop();
    });

    test('two supervisors, a schedule every second: each second once, on time, no gap; both fire some; then one dies and the other goes on', async () => {
        const [a, b] = await Promise.all([startSupervisor(), startSupervisor()]);
        const flowId = await deployedFlow('Every second');
        const cron = '* * * * * *';
        const schedule = (await call('POST', `/flows/${flowId}/schedules`, { cron, timezone: 'UTC' })).body.id as string;

        await until(async () => (await runsOf(schedule)).length >= 8);
        // one of them dies: the other one fires the next seconds alone
        await stop(a.child);
        const afterDeath = (await runsOf(schedule)).length;
        await until(async () => (await runsOf(schedule)).length >= afterDeath + 4);
        await turnOff(schedule, cron);
        await until(async () => (await runsOf(schedule)).every(r => r.status !== 'queued' && r.status !== 'running'));

        const fired = await runsOf(schedule);
        const seconds = fired.map(r => new Date(r.scheduled_for).getTime());
        // never two runs for a second, and every second from the first to the last (each one fired, or skipped)
        expect(new Set(seconds).size).toBe(seconds.length);
        for (let i = 1; i < seconds.length; i++) {
            expect(seconds[i]! - seconds[i - 1]!).toBe(1000);
        }

        // queued on time: the supervisors' timer, not the 5-second poll
        const late = fired.map(r => new Date(r.queued_at).getTime() - new Date(r.scheduled_for).getTime());
        expect(Math.max(...late)).toBeLessThan(1500);
        // they ran (a skipped one is a second its previous run had not ended yet)
        expect(fired.filter(r => r.status !== 'skipped').length).toBeGreaterThan(fired.length / 2);
        // the one the dying supervisor had going fails, with why
        for (const run of fired.filter(r => !['completed', 'with-warnings', 'skipped'].includes(r.status))) {
            expect(run.status).toBe('failed');
            expect(run.error).toMatch(/supervisor (running it )?stopped/i);
        }

        // both fired some while both were up (each logs the runs it fires)
        const firedBy = (lines: string[]) => lines.filter(line => line.includes(`schedule ${schedule}:`)).length;
        expect(firedBy(a.lines)).toBeGreaterThan(0);
        expect(firedBy(b.lines)).toBeGreaterThan(0);
        expect(firedBy(a.lines) + firedBy(b.lines)).toBe(fired.length);
        await stop(b.child);
    });

    test('times missed while no supervisor ran: relaxed runs once, strict each one, ignorable none, as the first supervisor starts', async () => {
        const flowId = await deployedFlow('Missed');
        const cron = '0 * * * * *';
        const make = async (misfire: string) =>
            (await call('POST', `/flows/${flowId}/schedules`, { cron, timezone: 'UTC', misfire })).body.id as string;
        const [relaxed, strict, ignorable] = [await make('relaxed'), await make('strict'), await make('ignorable')];
        // as if they were due 5 minutes ago and no supervisor was up since
        const fiveMinutesAgo = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000);
        await db.query('UPDATE flow_schedules SET next_fire_at = $1 WHERE id = ANY($2::uuid[])', [
            fiveMinutesAgo,
            [relaxed, strict, ignorable],
        ]);

        // due at the 6 minutes from then to now: the last one is on time (less than 60 s ago), the 5 before it missed
        const supervisor = await startSupervisor();
        await until(
            async () => (await runsOf(relaxed)).length > 0 && (await runsOf(strict)).length >= 6 && (await runsOf(ignorable)).length > 0,
        );
        for (const id of [relaxed, strict, ignorable]) {
            await turnOff(id, cron);
        }

        const times = async (id: string) => (await runsOf(id)).map(r => new Date(r.scheduled_for).getTime());
        const now = Math.floor(fiveMinutesAgo.getTime() / 60_000) * 60_000 + 5 * 60_000;
        // relaxed: once (the one on time covers the missed ones); strict: each one; ignorable: only the one on time
        expect(await times(relaxed)).toEqual([now]);
        expect(await times(strict)).toEqual([0, 1, 2, 3, 4, 5].map(i => fiveMinutesAgo.getTime() + i * 60_000));
        expect(await times(ignorable)).toEqual([now]);
        await stop(supervisor.child);
    });
});
