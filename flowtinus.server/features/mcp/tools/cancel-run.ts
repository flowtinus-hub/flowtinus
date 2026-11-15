import { CancelRunHandler } from '#features/runs/cancel-run/cancel-run-handler';
import { findRun } from '#features/runs/run-queue';
import { answer, defineTool, failed, id } from './tool';

export const cancelRun = defineTool({
    name: 'cancel_run',
    scope: 'runs:test',
    description: "Stops a run this token's user started (a queued one at once; a running one is told to stop).",
    input: { runId: id('the run') },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async ({ runId }, t) => {
        const run = await findRun(t.ctx.db, runId, t.ctx.workspaceId);
        if (!run) {
            return failed({ code: 'not-found', message: 'Run not found.' });
        }
        const startedBy = (run as { userId?: string }).userId ?? run.startedBy;
        if (startedBy !== t.ctx.userId) {
            return failed({ code: 'forbidden', message: 'Only a run this token’s user started can be stopped here.' });
        }
        return answer(await new CancelRunHandler().handle({ id: runId }, t.ctx));
    },
});
