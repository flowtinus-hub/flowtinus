import { z } from 'zod';
import { pinnedFromRun, type RunProgress, type RunRecord } from '@flowtinus/core';
import { GetRunHandler } from '#features/runs/get-run/get-run-handler';
import { SetPinHandler } from '#features/pins/pin-handlers';
import { findSubRun, subRunPathOf } from '../run-summary';
import { subRunArg } from './get-run';
import { defineTool, failed, id, ok } from './tool';

export const pinFromRun = defineTool({
    name: 'pin_from_run',
    scope: 'flows:write',
    description:
        "Pins a component's output from a run, as the editor's Pin output does. A pin is your user's own: the same in your user's editor, never seen by anyone else, never in the draft (no new revision) nor committed. The component's pinned output becomes what went out of it in that run (each port, or only `port`), as the run's record kept it (the first 50 envelopes per port, 5 in a called flow's record): your user's test runs (test_run, the editor's Run) replay it instead of running the component (and skip what only feeds it); a run for real always runs it. The run is one of this flow, or, with subRunId, a call another flow's run made to this flow (from get_run's subRuns): a way to test this flow with real data from the caller. A pin already there is replaced; unpin takes one off.",
    input: {
        flowId: id('the flow'),
        nodeId: z.string().min(1).describe("the component's id (the same in the run and in the draft)"),
        runId: id('the run to take the output from (test_run, get_run, list_runs)'),
        port: z.string().optional().describe('only this output port; without it, every port, as the editor pins'),
        subRunId: subRunArg,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async ({ flowId, nodeId, runId, port, subRunId }, t) => {
        const found = await t.flowAndDraft(flowId);
        if (!found.ok) {
            return failed(found.error);
        }
        const { flow, draft } = found.value;

        const run = await new GetRunHandler().handle({ id: runId }, t.ctx);
        if (!run.ok) {
            return failed(run.error);
        }
        if (run.value.status === 'queued' || run.value.status === 'running') {
            return failed({ code: 'validation', message: 'The run has not ended yet: pin from it once it ended (get_run).' });
        }

        let record = run.value.record as RunRecord | RunProgress | null;
        const path = subRunPathOf(subRunId);
        if (path.length) {
            const sub = findSubRun(record, path);
            if (!sub.ok) {
                return failed({ code: 'not-found', message: sub.error });
            }
            // a called flow's record names the flow, not its id
            if (sub.value.sub.flow !== flow.name) {
                return failed({
                    code: 'validation',
                    message: `The sub-run ${path.at(-1)} is a run of the flow "${sub.value.sub.flow}", not of "${flow.name}".`,
                });
            }
            record = sub.value.record;
        } else if (run.value.flowId !== flowId) {
            return failed({
                code: 'validation',
                message: `The run ${runId} is of another flow (${run.value.flowId}): pin from a run of this flow, or name a call to it with subRunId.`,
            });
        }

        const component = record?.components.find(c => c.nodeId === nodeId);
        const node = draft.flow.nodes.find(n => n.id === nodeId);
        if (!component || !node) {
            return failed({
                code: 'not-found',
                message: !node ? `The draft has no component ${nodeId}.` : `The component ${nodeId} did not run in that run.`,
            });
        }
        if (component.type !== node.type) {
            return failed({
                code: 'validation',
                message: `The component ${nodeId} is a ${node.type} in the draft and was a ${component.type} in the run: it changed since.`,
            });
        }

        const pin = pinnedFromRun(component, port);
        if (!pin.ok) {
            return failed({ code: 'validation', message: pin.error });
        }
        const saved = await new SetPinHandler().handle({ id: flowId, nodeId, pinned: pin.pinned }, t.ctx);
        if (!saved.ok) {
            return failed(saved.error);
        }
        return ok({
            nodeId,
            pinned: Object.fromEntries(Object.entries(pin.pinned).map(([p, items]) => [p, items.length])),
            ...(pin.missing
                ? {
                      missing: pin.missing,
                      note: `${pin.missing} envelope(s) went out in the run and are not in the pin: a record keeps only the first ones.`,
                  }
                : {}),
            ...t.flowLink(flow.projectId, flowId),
        });
    },
});
