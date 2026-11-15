import { z } from 'zod';
import type { RunProgress, RunRecord } from '@flowtinus/core';
import { GetRunHandler } from '#features/runs/get-run/get-run-handler';
import { findSubRun, runSummary, subRunPathOf, subRunSummaryView } from '../run-summary';
import { defineTool, failed, id, ok } from './tool';

export const subRunArg = z
    .union([z.string(), z.array(z.string()).min(1).max(10)])
    .optional()
    .describe(
        "a flow the run called (a Flow Invoker's call): its id from the summary's subRuns, or the ids from the run down to a call of a call ([child, grandchild])",
    );

export const getRun = defineTool({
    name: 'get_run',
    scope: 'runs:read',
    description:
        "A run's summary (a test run or a real one): its status and, per component, envelopes in and out per port, errors, what it wrote per table (writes), the flows a Flow Invoker called (subRuns: id, flow, status, duration, envelopes at their End, first error) and a few envelopes (shrunk to fit when large: get_run_output gives them whole). While it runs, what it did so far. With subRunId, the summary of that called flow's run, read from the record its caller keeps (fewer envelopes per port).",
    input: {
        runId: id('the run, from test_run, list_runs or resolve_url'),
        subRunId: subRunArg,
        sample: z.number().int().min(0).max(10).default(5).describe('envelopes per component and port'),
    },
    run: async ({ runId, subRunId, sample }, t) => {
        const run = await new GetRunHandler().handle({ id: runId }, t.ctx);
        if (!run.ok) {
            return failed(run.error);
        }
        const path = subRunPathOf(subRunId);
        if (path.length === 0) {
            return ok(runSummary(run.value, sample, t.runLink(run.value.id)));
        }
        const found = findSubRun(run.value.record as RunRecord | RunProgress | null, path);
        return found.ok ? ok(subRunSummaryView(run.value, found.value, sample)) : failed({ code: 'not-found', message: found.error });
    },
});
