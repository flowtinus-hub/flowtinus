import { z } from 'zod';
import type { RunProgress, RunRecord } from '@flowtinus/core';
import { GetRunHandler } from '#features/runs/get-run/get-run-handler';
import { findSubRun, MAX_OUTPUT_PAGE, runOutputPage, subRunPathOf } from '../run-summary';
import { subRunArg } from './get-run';
import { defineTool, failed, id, ok } from './tool';

export const getRunOutput = defineTool({
    name: 'get_run_output',
    scope: 'runs:read',
    description:
        "The envelopes a run's record keeps of one component's port, whole (not shrunk like the summary's sample), a page at a time: an output port (out-0, error, a Router's case...), or `input` for what came in (the End's input is what reached the End). A record keeps the first 50 envelopes per port (fewer when they are large; a called flow's record, 5): the answer says how many went through (total), how many the record has (inRecord) and how many it does not (leftOut), and `next`, the offset of the next page. With subRunId, a component of a flow the run called (as get_run).",
    input: {
        runId: id('the run, from test_run, list_runs or resolve_url'),
        nodeId: z.string().min(1).describe("the component's id in the flow"),
        port: z
            .string()
            .optional()
            .describe(
                'an output port, `input`, or one input port of several (in-1); without it, the first output port with envelopes (else input)',
            ),
        offset: z.number().int().min(0).default(0).describe('the first envelope (0 = the first the record has)'),
        limit: z.number().int().min(1).max(MAX_OUTPUT_PAGE).default(10).describe('envelopes per page (fewer when large)'),
        subRunId: subRunArg,
    },
    run: async ({ runId, nodeId, port, offset, limit, subRunId }, t) => {
        const run = await new GetRunHandler().handle({ id: runId }, t.ctx);
        if (!run.ok) {
            return failed(run.error);
        }
        let record = run.value.record as RunRecord | RunProgress | null;
        const path = subRunPathOf(subRunId);
        if (path.length) {
            const found = findSubRun(record, path);
            if (!found.ok) {
                return failed({ code: 'not-found', message: found.error });
            }
            record = found.value.record;
        }
        const page = runOutputPage(record, { runId, nodeId, ...(port !== undefined ? { port } : {}), offset, limit, subRunPath: path });
        return page.ok ? ok(page.value) : failed({ code: 'not-found', message: page.error });
    },
});
