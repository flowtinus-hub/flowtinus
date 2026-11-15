import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { insertWorkspace } from '../helpers/workspaces';
import { hostname } from 'node:os';
import { queueCalledRun, type QueuedRun } from '#features/runs/run-queue';
import { openDatabase, type Database } from '#shared/database/database';
import { silentLogger } from '#shared/logging/logger';
import { Supervisor } from '../../supervisor/supervisor';
import { inProcessExecutor } from '../../supervisor/workers/executor';

/**
 * Supervisors that are gone, as another one finds them (PGlite, one process): one not seen for a minute, wherever it
 * ran; one of this host whose pid is gone, only once it also stopped saying it is alive (the same host name in another
 * process namespace must not fail a live supervisor's runs). And a fire and forget run goes to its flow's own tag.
 */
describe('supervisors that are gone; tags of the runs a run queues', () => {
    let db: Database;
    const workspaceId = crypto.randomUUID();
    // a pid no process has here
    const deadPid = 2_147_000_000;

    const supervisorRow = (id: string, tags: string[], secondsAgo: number) =>
        db.query(
            `INSERT INTO supervisors (id, tags, workers, host, last_seen) VALUES ($1, $2::text[], 1, 'h', now() - make_interval(secs => $3))`,
            [id, tags, secondsAgo],
        );

    const runningOf = async (workerId: string) => {
        const id = crypto.randomUUID();
        await db.query(
            `INSERT INTO runs (id, workspace_id, flow_id, mode, draft_hash, status, trigger, worker_id, started_at, heartbeat_at)
       VALUES ($1, $2, $3, 'execution', 'h', 'running', 'manual', $4, now(), now())`,
            [id, workspaceId, crypto.randomUUID(), workerId],
        );
        return id;
    };

    const statusOf = async (id: string) => (await db.query<{ status: string }>('SELECT status FROM runs WHERE id = $1', [id]))[0]?.status;
    const ids = async () => (await db.query<{ id: string }>('SELECT id FROM supervisors ORDER BY id')).map(r => r.id);

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId, 'acme');
    });

    afterAll(async () => {
        await db.close();
    });

    test('lost ones and dead ones of this host that went quiet are reaped (their runs fail); a quiet-less one is kept', async () => {
        const lost = 'elsewhere-1-aaaaaaaa';
        const twin = `${hostname()}-${deadPid}-bbbbbbbb`;
        const quietDead = `${hostname()}-${deadPid + 1}-cccccccc`;
        await supervisorRow(lost, ['default'], 5 * 60);
        // the same host name, its pid not here, but it says it is alive (another container named alike)
        await supervisorRow(twin, ['default'], 1);
        await supervisorRow(quietDead, ['default'], 20);
        const lostRun = await runningOf(lost);
        const twinRun = await runningOf(twin);
        const deadRun = await runningOf(quietDead);

        const supervisor = new Supervisor({
            db,
            executor: inProcessExecutor({ size: 1 }),
            tags: ['default'],
            logger: silentLogger(),
            heartbeatMs: 5_000,
        });
        await supervisor.start();
        try {
            expect(await statusOf(lostRun)).toBe('failed');
            expect(await statusOf(deadRun)).toBe('failed');
            expect(await statusOf(twinRun)).toBe('running');
            expect(await ids()).toEqual([twin, supervisor.id].sort());
            const [own] = await db.query<{ host: string; ff: number }>(
                'SELECT host, fire_and_forget_per_worker AS ff FROM supervisors WHERE id = $1',
                [supervisor.id],
            );
            expect(own?.host).toBe(hostname());
            // the default fire and forget limit per worker, for the Workers page
            expect(own?.ff).toBe(4);
        } finally {
            await supervisor.stop();
        }
    });

    test("a fire and forget run goes to the called flow's own tag, refused while no live supervisor has it", async () => {
        await db.exec('DELETE FROM supervisors');
        const calledId = crypto.randomUUID();
        const flow = { version: 1, name: 'Called', nodes: [], edges: [] };
        const parent = {
            id: crypto.randomUUID(),
            workspaceId,
            projectId: null,
            rootId: null,
            workerTag: 'default',
            priority: 0,
            scripts: null,
            table: 'runs',
            calledFlows: [{ id: calledId, name: 'Called', flow, workerTag: 'heavy' }],
        } as unknown as QueuedRun;
        const request = { flowId: calledId, nodeId: 'n', nodeLabel: 'Call', chain: [], rootName: 'Root', parameters: {} };

        await expect(queueCalledRun(db, parent, request as never)).rejects.toThrow('No worker takes the tag "heavy"');

        await supervisorRow('heavy-1-dddddddd', ['heavy'], 1);
        const queued = await queueCalledRun(db, parent, request as never);
        const [row] = await db.query<{ worker_tag: string }>('SELECT worker_tag FROM runs WHERE id = $1', [queued.id]);
        expect(row?.worker_tag).toBe('heavy');
    });
});
