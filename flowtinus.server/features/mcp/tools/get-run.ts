import { z } from 'zod';
import type { RunProgress, RunRecord } from '@flowtinus/core';
import { GetRunHandler } from '#features/runs/get-run/get-run-handler';
import { runAnswer, subRunAnswer } from '../run-result';
import { findSubRun, subRunPathOf } from '../run-summary';
import { defineTool, failed, id, ok } from './tool';

export const subRunArg = z
    .union([z.string(), z.array(z.string()).min(1).max(10)])
    .optional()
    .describe(
        "a flow the run called (a Flow Invoker's call): its id from the summary's subRuns, or the ids from the run down to a call of a call ([child, grandchild])",
    );

export const detailArg = z
    .enum(['result', 'summary'])
    .optional()
    .describe(
        "result: status, the End's output, writes, the user's warnings and errors; summary: the detail per component. Default: result when the run is clean (completed, no envelope in error), summary otherwise",
    );

export const getRun = defineTool({
    name: 'get_run',
    scope: 'runs:read',
    description:
        "A run (a test run or a real one). Clean (completed, no envelope in error): its run result: status, the envelopes at its End (output, outputCount; get_run_output on the End pages them), writes and warnings. Otherwise, its summary: per component, envelopes in and out per port, errors, what it wrote per table (writes), the flows a Flow Invoker called (subRuns: id, flow, status, duration, envelopes at their End, first error) and a few envelopes (shrunk to fit when large: get_run_output gives them whole). While it runs, what it did so far. With subRunId, that called flow's run, the same way, read from the record its caller keeps (fewer envelopes per port).",
    input: {
        runId: id('the run, from test_run, list_runs or resolve_url'),
        subRunId: subRunArg,
        detail: detailArg,
        sample: z.number().int().min(0).max(10).default(5).describe('envelopes per component and port'),
    },
    run: async ({ runId, subRunId, detail, sample }, t) => {
        const run = await new GetRunHandler().handle({ id: runId }, t.ctx);
        if (!run.ok) {
            return failed(run.error);
        }
        const path = subRunPathOf(subRunId);
        if (path.length === 0) {
            return ok(runAnswer(run.value, { detail, sample, editorUrl: t.runLink(run.value.id) }));
        }
        const found = findSubRun(run.value.record as RunRecord | RunProgress | null, path);
        return found.ok
            ? ok(subRunAnswer(run.value, found.value, { detail, sample }))
            : failed({ code: 'not-found', message: found.error });
    },
});
