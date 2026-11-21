import { z } from 'zod';
import type { RunProgress, RunRecord } from '@flowtinus/core';
import { eq } from 'drizzle-orm';
import { workspaces } from '#features/workspaces/workspace';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import type { Run, RunRowStatus } from '../run';
import { usageOf } from '../run-events';
import { calledRunsOf, findRun, type CalledRunView } from '../run-queue';

export const GetRunQuery = z.object({ id: z.uuid('Invalid') });

export type RunView = {
    id: string;
    flowId: string;
    flowName: string | null;
    projectId: string | null;
    workspaceHandle: string;
    trigger: Run['trigger'];
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    mode: 'validation' | 'execution';
    status: RunRowStatus;
    record: RunRecord | RunProgress | null;
    usage: RunUsageView | null;
    parentId: string | null;
    rootId: string | null;
    parentNodeId: string | null;
    calledRuns: CalledRunView[];
};

export type RunUsageView = { startRssBytes: number | null; peakRssBytes: number | null; cpuMs: number | null };

/** raw SQL may give a timestamp as a Date or a string */
const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

export class GetRunHandler implements UseCaseHandler<RunView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<RunView>> {
        const parsed = validate(GetRunQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const run = await findRun(ctx.db, parsed.value.id, ctx.workspaceId);
        if (!run) {
            return fail('not-found', 'Run not found.');
        }

        const [workspace] = await ctx.db.orm
            .select({ handle: workspaces.handle })
            .from(workspaces)
            .where(eq(workspaces.id, ctx.workspaceId));
        const live = run.status === 'running' ? (run.progress as RunProgress | null) : null;
        return success({
            id: run.id,
            flowId: run.flowId,
            flowName: run.flowName,
            projectId: run.projectId,
            workspaceHandle: workspace?.handle ?? '',
            trigger: run.trigger,
            queuedAt: iso(run.queuedAt)!,
            startedAt: iso(run.startedAt),
            finishedAt: iso(run.finishedAt),
            mode: run.mode,
            status: run.status,
            record: live ?? (run.record as RunRecord | null) ?? null,
            usage: usageOf(run),
            parentId: run.parentId,
            rootId: run.rootId,
            parentNodeId: run.parentNodeId,
            calledRuns: run.table === 'runs' ? await calledRunsOf(ctx.db, run.id, ctx.workspaceId) : [],
        });
    }
}
