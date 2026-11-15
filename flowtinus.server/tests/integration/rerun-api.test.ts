import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { BIA, insertUser, insertWorkspace, wsPath } from '../helpers/workspaces';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

describe('re-run a failed run', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    const workspaceId = crypto.randomUUID();
    const headers = { 'x-user-id': BIA, 'content-type': 'application/json' };
    const call = async (method: string, path: string) => {
        const response = await app.request(wsPath(workspaceId, path), { method, headers });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    /** a run for real as it ended */
    let flowId = '';
    const run = async (status: string, workerTag = 'default', flow = flowId) => {
        const id = crypto.randomUUID();
        await db.query(
            `INSERT INTO runs (id, workspace_id, flow_id, mode, draft_hash, status, trigger, worker_tag, priority, parameters, input, definition,
         scripts, flow_name, started_by, error)
       VALUES ($1, $2, $3, 'execution', 'h', $4, 'schedule', $5, 3, '{"since":"1"}', '[1,2]', '{"name":"Orders"}', '{"a":"x"}', 'Orders', 'ana', 'boom')`,
            [id, workspaceId, flow, status, workerTag],
        );
        return id;
    };

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId, 'acme');
        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-rerun', '{default}', 1, 'test')`);
        app = createApp(db, 'DEV');
        const projectId = (await (
            await app.request(wsPath(workspaceId, '/projects'), { method: 'POST', headers, body: JSON.stringify({ name: 'Reruns' }) })
        ).json()) as { id: string };
        flowId = (
            (await (
                await app.request(wsPath(workspaceId, `/projects/${projectId.id}/flows`), {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name: 'Orders' }),
                })
            ).json()) as { id: string }
        ).id;
    });

    afterAll(async () => {
        await db.close();
    });

    test('a failed run is queued again with the same snapshot, as a new run started by who asked', async () => {
        const failed = await run('failed');
        const answer = await call('POST', `/runs/${failed}/rerun`);
        expect(answer.status).toBe(202);
        const id = answer.body.id as string;
        expect(id).not.toBe(failed);

        const [copy] = await db.query<Record<string, unknown>>('SELECT * FROM runs WHERE id = $1', [id]);
        expect(copy).toMatchObject({
            status: 'queued',
            trigger: 'manual',
            mode: 'execution',
            draft_hash: 'h',
            worker_tag: 'default',
            priority: 3,
            parameters: { since: '1' },
            input: [1, 2],
            definition: { name: 'Orders' },
            scripts: { a: 'x' },
            flow_name: 'Orders',
            started_by: BIA,
            rerun_of: failed,
            error: null,
            record: null,
        });
        const listed = (await call('GET', '/runs')).body as { runs: { id: string; rerunOf: string | null }[] };
        expect(listed.runs.find(r => r.id === id)!.rerunOf).toBe(failed);
    });

    test('refused: a run that did not fail, one of a tag no worker takes, one of another workspace', async () => {
        expect((await call('POST', `/runs/${await run('completed')}/rerun`)).status).toBe(400);
        const heavy = await call('POST', `/runs/${await run('failed', 'heavy')}/rerun`);
        expect(heavy.status).toBe(502);
        // asked by a user who is not a member of its workspace: not found
        const other = await app.request(`/runs/${await run('failed')}/rerun`, {
            method: 'POST',
            headers: { ...headers, 'x-user-id': await insertUser(db) },
        });
        expect(other.status).toBe(404);
        const gone = await call('POST', `/runs/${await run('failed', 'default', crypto.randomUUID())}/rerun`);
        expect(gone.status).toBe(400);
    });
});
