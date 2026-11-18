import { z } from 'zod';
import { runForRealCheck } from '#features/api-tokens/run-scope';
import { FlowRepository, loadTree } from '#features/folders/project-tree';
import { StartRunHandler } from '#features/runs/start-run/start-run-handler';
import { draftRunNotice } from '#features/git/git-config';
import { runAnswer } from '../run-result';
import { detailArg } from './get-run';
import { DEFAULT_TEST_RUN_WAIT_S, MAX_TEST_RUN_WAIT_S, waitForEnd } from './test-run';
import { defineTool, failed, id, logApproval, ok, userApproval } from './tool';

/*
 * The editor's Run for real, through the MCP: the saved draft runs for real (databases are written, POSTs are sent). The
 * guards besides the description, because a description is guidance a model may ignore: the scope runs:execute (a
 * token has it only when its owner gave it; test_run's runs:test is not enough), and either the token's run scope (the
 * folders or flows its owner allowed when making it: a flow in it runs, no other does; run-scope.ts) or, for a token
 * without one, userApproval, the user's own words authorizing it, required and kept in the server's log with the run's
 * id. The server cannot tell whether the words are really the user's: the scope is the hard switch.
 */
export const runForReal = defineTool({
    name: 'run_for_real',
    scope: 'runs:execute',
    description:
        "Runs the flow's saved draft FOR REAL, as the editor's Run for real does: components that write outside DO write (databases are changed, POSTs are sent, files are written); it cannot be undone. " +
        "A token held to some folders or flows (its run scope, set by its owner when making it) runs for real only those flows (and their subfolders' flows), without userApproval (the scope is the user's approval; one given is only logged): any other flow is refused by the server, and a flow it calls outside the scope fails that call. " +
        'A token without a run scope needs the user\'s explicit approval: ONLY call it after the user explicitly authorized running for real in this conversation, either for this flow (e.g. "run X for real", "run it for real") or for any flow, a standing approval for the rest of the conversation (e.g. "you can run any flow you want for real"). ' +
        'A standing approval ends when the user withdraws or narrows it ("stop running for real", "only flow X"). A request to test, check, debug or fix the flow is NOT an approval (use test_run), nor is an approval given for one other flow. ' +
        'When the user did not say it explicitly, do not call it: ask the user ("Can I run <flow> for real? It writes to ...") or say that running for real needs their explicit approval. ' +
        "userApproval must then quote the user's message that authorized it (the standing approval when that is the one), word for word; never write it yourself. " +
        'Waits for the run up to timeoutS. A clean run (completed, no envelope in error) answers its run result: status, the envelopes at its End and what it wrote per table (writes); otherwise a summary per component (with what each database component wrote); if it is still running, answers status running and the runId (continue with get_run; cancel_run stops it).',
    input: {
        flowId: id('the flow'),
        userApproval: userApproval('running this flow for real (or any flow, for a standing approval)')
            .optional()
            .describe(
                "the user's message in this conversation that explicitly authorized running this flow for real (or any flow), quoted word for word (kept in the server's log); required unless the token's run scope covers the flow",
            ),
        input: z
            .unknown()
            .optional()
            .describe("the flow's input (JSON), for a Start that accepts one; without it, the Start's default input"),
        parameters: z.record(z.string(), z.string()).optional().describe("the Start's parameters, as text"),
        timeoutS: z.number().int().min(0).max(MAX_TEST_RUN_WAIT_S).default(DEFAULT_TEST_RUN_WAIT_S).describe('how long to wait for it'),
        detail: detailArg,
        sample: z.number().int().min(0).max(10).default(3).describe('envelopes per component and port in the answer'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: async ({ flowId, userApproval: approval, input, parameters, timeoutS, detail, sample }, t) => {
        // the token's run scope, or the user's words: checked before anything is queued
        const scope = t.options.runScope ?? null;
        const row = await new FlowRepository(t.ctx.db, t.ctx.workspaceId).findById(flowId);
        if (!row) {
            return failed({ code: 'not-found', message: 'Flow not found.' });
        }
        const tree = scope ? await loadTree(t.ctx.db, t.ctx.workspaceId, row.projectId) : null;
        const allowed = runForRealCheck(scope, row, tree?.folders ?? [], approval);
        if (!allowed.ok) {
            return failed({ code: allowed.code, message: allowed.message });
        }

        const started = await new StartRunHandler({ runScope: scope }).handle(
            { id: flowId, mode: 'execution', parameters: parameters ?? {}, ...(input !== undefined ? { input } : {}) },
            t.ctx,
        );
        if (!started.ok) {
            return failed(started.error);
        }
        const runId = started.value.id;
        logApproval(
            'run_for_real',
            `run ${runId} of flow ${flowId}`,
            t.ctx,
            allowed.byScope ? `(the token's run scope) ${approval ?? ''}`.trim() : approval!,
        );
        const run = await waitForEnd(t, runId, Math.min(timeoutS, t.options.maxWaitS ?? MAX_TEST_RUN_WAIT_S));
        if (!run.ok) {
            return failed(run.error);
        }
        const answer = runAnswer(run.value, { detail, sample, editorUrl: t.runLink(runId) });
        const notice = await draftRunNotice(t.ctx.db, t.ctx.workspaceId);
        return ok({
            ...('components' in answer
                ? {
                      ...answer,
                      ...(approval ? { userApproval: approval } : {}),
                      ...(allowed.byScope ? { approvedBy: "the token's run scope" } : {}),
                  }
                : answer),
            ...(notice ? { notice } : {}),
        });
    },
});
