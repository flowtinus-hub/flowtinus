import { z } from 'zod';
import { withoutPins, type FlowFile } from '@flowtinus/core';
import { SaveDraftHandler } from '#features/flows/save-draft/save-draft-handler';
import { defineTool, failed, id, ok } from './tool';

/* save_draft keeps the pins of the nodes that come without one, so taking one off needs a tool of its own. */
export const unpin = defineTool({
    name: 'unpin',
    scope: 'flows:write',
    description:
        "CHANGES THE FLOW'S DRAFT (a new revision): takes the pinned output off one component (or several), as the editor's Unpin output does: test runs run it again instead of replaying the pin. (save_draft cannot take a pin off: it keeps the pins of nodes that come without one.) A node without a pin is reported in notPinned, one not in the draft in notFound; when none had a pin nothing is saved. get_flow lists the pinned nodes (pinnedNodes). expectedRevision, when given, refuses it if the draft changed since.",
    input: {
        flowId: id('the flow whose draft loses the pin'),
        nodeId: z
            .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(200)])
            .describe("the component's id in the draft, or a list of them"),
        expectedRevision: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("the draft's revision it is based on (get_flow); refused if it changed"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async ({ flowId, nodeId, expectedRevision }, t) => {
        const found = await t.flowAndDraft(flowId);
        if (!found.ok) {
            return failed(found.error);
        }
        const { flow, draft } = found.value;
        if (expectedRevision !== undefined && draft.revision !== expectedRevision) {
            return failed({
                code: 'conflict',
                message: 'The draft changed since it was read: read it again with get_flow.',
                currentRevision: draft.revision,
            });
        }

        const result = withoutPins(draft.flow.nodes, Array.isArray(nodeId) ? nodeId : [nodeId]);
        const said = {
            ...(result.notPinned.length ? { notPinned: result.notPinned } : {}),
            ...(result.notFound.length ? { notFound: result.notFound } : {}),
        };
        if (result.unpinned.length === 0) {
            return ok({
                revision: draft.revision,
                unpinned: [],
                ...said,
                message: 'Nothing was pinned there: the draft was not changed.',
            });
        }

        const file: FlowFile = { ...draft.flow, nodes: result.nodes };
        const saved = await new SaveDraftHandler().handle({ id: flowId, revision: draft.revision, flow: file }, t.ctx);
        if (!saved.ok) {
            return failed(saved.error);
        }
        return ok({ revision: saved.value.revision, unpinned: result.unpinned, ...said, ...t.flowLink(flow.projectId, flowId) });
    },
});
