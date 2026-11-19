import { currentFlow } from '#features/git/branch-read';
import { z } from 'zod';
import type { RunRecord } from '@flowtinus/core';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import type { RunUsageView } from '../get-run/get-run-handler';
import { usageOf } from '../run-events';

export const LastRunQuery = z.object({ id: z.uuid('Invalid') });

export type LastRunView = {
    last: { id: string; mode: 'validation' | 'execution'; finishedAt: string; record: RunRecord; usage: RunUsageView | null } | null;
    full: RunRecord | null;
};

type Row = {
    id: string;
    mode: 'validation' | 'execution';
    finished_at: Date;
    record: RunRecord;
    start_rss_bytes: unknown;
    peak_rss_bytes: unknown;
    cpu_ms: unknown;
};

const ENDED = `record IS NOT NULL AND status NOT IN ('queued', 'running') AND finished_at IS NOT NULL`;

export class LastRunHandler implements UseCaseHandler<LastRunView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<LastRunView>> {
        const parsed = validate(LastRunQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const flowId = parsed.value.id;
        if (!(await currentFlow(ctx, flowId))) {
            return fail('not-found', 'Flow not found.');
        }

        const columns = 'id, mode, finished_at, record, start_rss_bytes, peak_rss_bytes, cpu_ms';
        const [test] = await ctx.db.query<Row>(
            `SELECT ${columns} FROM test_runs WHERE workspace_id = $1 AND flow_id = $2 AND user_id = $3 AND ${ENDED} ORDER BY finished_at DESC LIMIT 1`,
            [ctx.workspaceId, flowId, ctx.userId],
        );
        const [real] = await ctx.db.query<Row>(
            `SELECT ${columns} FROM runs WHERE workspace_id = $1 AND flow_id = $2 AND mode = 'execution' AND ${ENDED} ORDER BY finished_at DESC LIMIT 1`,
            [ctx.workspaceId, flowId],
        );
        const [full] = await ctx.db.query<{ record: RunRecord }>(
            `SELECT record FROM test_runs WHERE workspace_id = $1 AND flow_id = $2 AND user_id = $3 AND run_from IS NULL AND ${ENDED}`,
            [ctx.workspaceId, flowId, ctx.userId],
        );

        const latest = [test, real]
            .filter((r): r is Row => !!r)
            .sort((a, b) => new Date(b.finished_at).getTime() - new Date(a.finished_at).getTime())[0];
        return success({
            last: latest
                ? {
                      id: latest.id,
                      mode: latest.mode,
                      finishedAt: new Date(latest.finished_at).toISOString(),
                      record: latest.record,
                      usage: usageOf({ startRssBytes: latest.start_rss_bytes, peakRssBytes: latest.peak_rss_bytes, cpuMs: latest.cpu_ms }),
                  }
                : null,
            full: full?.record ?? null,
        });
    }
}
