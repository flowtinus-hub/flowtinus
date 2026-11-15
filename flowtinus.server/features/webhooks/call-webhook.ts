import { END, END_SAMPLE_BYTES, START, startConfig, type FlowFile, type RunRecord } from '@flowtinus/core';
import { eq } from 'drizzle-orm';
import type { Database } from '#shared/database/database';
import { deployedRun } from '#features/runs/deployed-run';
import { runs } from '#features/runs/run';
import { CHANNELS, notifyRunEvent } from '#features/runs/run-queue';
import { tokenMatches, type WebhookResponse } from './webhooks';

/*
 * A call to a webhook (/wh/{id}, outside the editor's api: no workspace in the address, the token says who may call).
 * Queues a run of the flow's deployed version: a POST's JSON body is its input (a flow whose Start takes no input may be called with GET
 * too), the query string the Start's parameters. Answers 202 with the run's id, or, for a webhook that waits, what
 * reached the End once the run ends (up to `waitMs`: then 202 with the run's id, as if it had not waited). What reached
 * the End is its sample in the run's record, which keeps up to END_SAMPLE_BYTES of it: past that, the answer is an error
 * that says so, never part of the output as if it were all of it.
 */

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const WAIT_MS = 30_000;

export type WebhookCall = {
    id: string;
    method: string;
    authorization: string | undefined;
    query: Record<string, string>;
    body: string | undefined;
};

export type WebhookAnswer = { status: number; body: Record<string, unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENDED = ['completed', 'with-warnings', 'with-errors', 'failed', 'cancelled'];

type Row = {
    id: string;
    workspace_id: string;
    project_id: string;
    flow_id: string;
    enabled: boolean;
    response: WebhookResponse;
    token_hash: string;
    flow_name: string;
    worker_tag: string;
    archived: boolean;
    workspace_archived: boolean;
    version_id: string | null;
    definition: FlowFile | null;
};

const error = (status: number, message: string): WebhookAnswer => ({ status, body: { error: message } });

export async function callWebhook(db: Database, call: WebhookCall, waitMs = WAIT_MS): Promise<WebhookAnswer> {
    if (!UUID.test(call.id)) {
        return error(404, 'Webhook not found.');
    }

    const [row] = await db.query<Row>(
        `SELECT w.id, w.workspace_id, w.project_id, w.flow_id, w.enabled, w.response, w.token_hash, f.name AS flow_name, f.worker_tag,
       (f.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL) AS archived, (ws.deleted_at IS NOT NULL) AS workspace_archived, v.id AS version_id, v.definition
     FROM flow_webhooks w
     JOIN flows f ON f.id = w.flow_id
     JOIN projects p ON p.id = w.project_id
     JOIN workspaces ws ON ws.id = w.workspace_id
     LEFT JOIN deployments d ON d.flow_id = w.flow_id
     LEFT JOIN flow_versions v ON v.id = d.flow_version_id
     WHERE w.id = $1`,
        [call.id],
    );
    if (!row || !row.enabled) {
        return error(404, 'Webhook not found.');
    }

    const answer = async (result: WebhookAnswer, runId?: string): Promise<WebhookAnswer> => {
        await db.query('UPDATE flow_webhooks SET last_called_at = now(), last_status = $2, last_run_id = $3 WHERE id = $1', [
            row.id,
            result.status,
            runId ?? null,
        ]);
        return result;
    };

    const token = /^Bearer\s+(.+)$/i.exec(call.authorization ?? '')?.[1]?.trim();
    if (!token || !tokenMatches(token, row.token_hash)) {
        return answer(error(401, 'Missing or wrong token: send Authorization: Bearer <token>.'));
    }

    if (row.workspace_archived) {
        return answer(error(409, 'The workspace was archived.'));
    }
    if (row.archived) {
        return answer(error(409, 'The flow was archived.'));
    }

    if (!row.version_id || !row.definition) {
        return answer(error(409, 'The flow is not deployed.'));
    }

    const acceptsInput = startConfig(row.definition.nodes.find(n => n.type === START)?.config ?? {}).acceptsInput;
    if (call.method !== 'POST' && call.method !== 'GET') {
        return answer(error(405, acceptsInput ? 'Use POST.' : 'Use GET or POST.'));
    }

    if (call.method === 'GET' && acceptsInput) {
        return answer(error(405, 'This flow takes an input: POST it as JSON.'));
    }

    let input: unknown;
    if (call.method === 'POST' && call.body?.trim()) {
        if (call.body.length > MAX_BODY_BYTES) {
            return answer(error(413, `The body is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB.`));
        }

        try {
            input = JSON.parse(call.body);
        } catch {
            return answer(error(400, 'The body is not valid JSON.'));
        }
    }

    const prepared = await deployedRun(
        db,
        {
            workspaceId: row.workspace_id,
            projectId: row.project_id,
            flowId: row.flow_id,
            flowName: row.flow_name,
            workerTag: row.worker_tag,
            versionId: row.version_id,
            definition: row.definition,
        },
        'webhook',
        // a plain object (the query of a request has no prototype)
        Object.fromEntries(Object.entries(call.query)),
        input,
    );
    if (!prepared.ok) {
        const status = prepared.reason === 'input' ? 400 : prepared.reason === 'worker' ? 503 : 422;
        return answer(error(status, prepared.error));
    }

    const id = prepared.values.id;
    await db.orm.insert(runs).values({ ...prepared.values, webhookId: row.id });
    await notifyRunEvent(db, { id, type: 'status', workspaceId: row.workspace_id, rootId: id, status: 'queued' });
    await db.notify(CHANNELS.queued, row.worker_tag);
    if (row.response === 'async') {
        return answer({ status: 202, body: { runId: id, status: 'queued' } }, id);
    }

    const deadline = Date.now() + waitMs;
    for (;;) {
        const [run] = await db.orm
            .select({ status: runs.status, record: runs.record, error: runs.error })
            .from(runs)
            .where(eq(runs.id, id));
        if (run && ENDED.includes(run.status)) {
            const end = (run.record as RunRecord | null)?.components.find(c => c.type === END);
            const output = end?.inputSample ?? [];
            const ok = run.status === 'completed' || run.status === 'with-warnings';
            const notKept = end?.samplesNotKept?.input ?? 0;
            if (ok && notKept > 0) {
                const mb = END_SAMPLE_BYTES / 1024 / 1024;
                const error = `The run ${run.status}, but what reached the End is larger than the ${mb} MB a webhook answers with (${notKept} envelope(s) left out): read the run, or make the flow answer with less.`;
                return answer({ status: 500, body: { runId: id, status: run.status, error } }, id);
            }

            return answer(
                { status: ok ? 200 : 500, body: { runId: id, status: run.status, output, ...(run.error ? { error: run.error } : {}) } },
                id,
            );
        }

        if (Date.now() > deadline) {
            return answer({ status: 202, body: { runId: id, status: run?.status ?? 'queued' } }, id);
        }

        await Bun.sleep(150);
    }
}
