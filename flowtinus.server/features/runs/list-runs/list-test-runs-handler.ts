import { z } from 'zod';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import type { RunRowStatus } from '../run';
import { STATUS_FILTER, statusCondition } from './list-runs-handler';

/*
 * The user's test runs (the editor's Run, the MCP's test_run) in the request's workspace, newest first. test_runs keeps,
 * per flow and user, only the latest full test run and the latest Run from here, none older than a day
 * (run-queue.ts): a test run replaced by a newer one is gone. Only their columns, never record or
 * definition (big jsonb).
 */

export const ListTestRunsQuery = z.object({
    status: z.enum(STATUS_FILTER).default('all'),
    flow: z.uuid('Invalid').optional(),
    before: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type TestRunListItem = {
    id: string;
    status: RunRowStatus;
    flowId: string;
    flowName: string | null;
    projectId: string | null;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    envelopesIn: number | null;
    envelopesOut: number | null;
    error: string | null;
    fromNodeId: string | null;
};

type Row = Omit<TestRunListItem, 'queuedAt' | 'startedAt' | 'finishedAt' | 'durationMs' | 'envelopesIn' | 'envelopesOut'> & {
    queuedAt: Date | string;
    startedAt: Date | string | null;
    finishedAt: Date | string | null;
    durationMs: number | string | null;
    envelopesIn: number | string | null;
    envelopesOut: number | string | null;
};

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
const num = (v: number | string | null) => (v === null ? null : Number(v));

export type TestRunListPage = { runs: TestRunListItem[]; next: string | null };

export class ListTestRunsHandler implements UseCaseHandler<TestRunListPage> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<TestRunListPage>> {
        const parsed = validate(ListTestRunsQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { status, flow, before, limit } = parsed.value;
        const values: unknown[] = [ctx.workspaceId, ctx.userId];
        const param = (value: unknown) => {
            values.push(value);
            return `$${values.length}`;
        };
        const where = ['x.workspace_id = $1', 'x.user_id = $2'];
        const byStatus = statusCondition(status, param);
        if (byStatus) {
            where.push(byStatus);
        }
        if (flow) {
            where.push(`x.flow_id = ${param(flow)}`);
        }
        if (before) {
            const [at, id] = before.split('|');
            if (!at || !id || Number.isNaN(Date.parse(at))) {
                return fail('validation', 'Invalid page.');
            }

            where.push(`(x.queued_at, x.id) < (${param(at)}::timestamptz, ${param(id)}::uuid)`);
        }

        const rows = await ctx.db.query<Row>(
            `SELECT x.id, x.status, x.flow_id AS "flowId", x.flow_name AS "flowName", x.project_id AS "projectId",
              x.queued_at AS "queuedAt", x.started_at AS "startedAt", x.finished_at AS "finishedAt", x.duration_ms AS "durationMs",
              x.envelopes_in AS "envelopesIn", x.envelopes_out AS "envelopesOut", x.error, x.run_from->>'nodeId' AS "fromNodeId"
       FROM test_runs x WHERE ${where.join(' AND ')} ORDER BY x.queued_at DESC, x.id DESC LIMIT ${param(limit + 1)}`,
            values,
        );
        const runs = rows.slice(0, limit).map(r => ({
            ...r,
            queuedAt: iso(r.queuedAt)!,
            startedAt: iso(r.startedAt),
            finishedAt: iso(r.finishedAt),
            durationMs: num(r.durationMs),
            envelopesIn: num(r.envelopesIn),
            envelopesOut: num(r.envelopesOut),
        }));
        const last = runs.at(-1);
        return success({ runs, next: rows.length > limit && last ? `${last.queuedAt}|${last.id}` : null });
    }
}
