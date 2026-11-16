import { z } from 'zod';
import { GetRunHandler, type RunView } from '#features/runs/get-run/get-run-handler';
import { StartRunHandler } from '#features/runs/start-run/start-run-handler';
import type { UseCaseResult } from '#shared/use-cases/use-case-result';
import { runAnswer } from '../run-result';
import { detailArg } from './get-run';
import { defineTool, failed, id, ok, type ToolContext } from './tool';

export const DEFAULT_TEST_RUN_WAIT_S = 120;
export const MAX_TEST_RUN_WAIT_S = 600;

const ended = (status: RunView['status']) => status !== 'queued' && status !== 'running';

export async function waitForEnd(t: ToolContext, runId: string, timeoutS: number): Promise<UseCaseResult<RunView>> {
    const until = Date.now() + timeoutS * 1000;
    const poll = t.options.pollMs ?? 500;
    for (;;) {
        const run = await new GetRunHandler().handle({ id: runId }, t.ctx);
        if (!run.ok || ended(run.value.status) || Date.now() >= until) {
            return run;
        }
        await Bun.sleep(Math.min(poll, Math.max(0, until - Date.now())));
    }
}

export const testRun = defineTool({
    name: 'test_run',
    scope: 'runs:test',
    description:
        "Runs the flow's saved draft as the editor's Run does: a test run (components that write outside, a database or a POST, do not write; pinned outputs replay; a Flow Invoker calls the other flow's draft). Waits for it up to timeoutS. A clean run (completed, no envelope in error) answers its run result: status, the envelopes at its End (output, outputCount) and warnings. Otherwise a summary per component: envelopes in and out per port, errors with their messages, a Flow Invoker's calls (subRuns: get_run with subRunId reads one) and a few envelopes (shrunk when large: get_run_output gives them whole). If it is still running, answers status running and the runId: continue with get_run. Save the draft first.",
    input: {
        flowId: id('the flow'),
        input: z
            .unknown()
            .optional()
            .describe("the flow's input (JSON), for a Start that accepts one; without it, the Start's default input"),
        parameters: z.record(z.string(), z.string()).optional().describe("the Start's parameters, as text"),
        timeoutS: z.number().int().min(0).max(MAX_TEST_RUN_WAIT_S).default(DEFAULT_TEST_RUN_WAIT_S).describe('how long to wait for it'),
        detail: detailArg,
        sample: z.number().int().min(0).max(10).default(3).describe('envelopes per component and port in the answer'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async ({ flowId, input, parameters, timeoutS, detail, sample }, t) => {
        const started = await new StartRunHandler().handle(
            { id: flowId, mode: 'validation', parameters: parameters ?? {}, ...(input !== undefined ? { input } : {}) },
            t.ctx,
        );
        if (!started.ok) {
            return failed(started.error);
        }
        const run = await waitForEnd(t, started.value.id, Math.min(timeoutS, t.options.maxWaitS ?? MAX_TEST_RUN_WAIT_S));
        if (!run.ok) {
            return failed(run.error);
        }
        return ok(runAnswer(run.value, { detail, sample, editorUrl: t.runLink(run.value.id) }));
    },
});
