import { z } from 'zod';
import { withoutPins } from '@flowtinus/core';
import { pinsOf, removePins, withPins } from '#features/pins/pins';
import { requireRole } from '#shared/use-cases/require-role';
import { defineTool, failed, id, ok } from './tool';

export const unpin = defineTool({
    name: 'unpin',
    scope: 'flows:write',
    description:
        "Takes your user's pinned output off one component (or several), as the editor's Unpin output does: your user's test runs run it again instead of replaying the pin. The draft does not change (a pin is the user's, not the draft's). A node without a pin is reported in notPinned, one not in the draft in notFound. get_flow lists the pinned nodes (pinnedNodes).",
    input: {
        flowId: id('the flow'),
        nodeId: z
            .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(200)])
            .describe("the component's id in the draft, or a list of them"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async ({ flowId, nodeId }, t) => {
        const denied = requireRole(t.ctx, 'editor');
        if (denied && !denied.ok) {
            return failed(denied.error);
        }
        const found = await t.flowAndDraft(flowId);
        if (!found.ok) {
            return failed(found.error);
        }
        const { flow, draft } = found.value;

        const pins = await pinsOf(t.ctx.db, t.ctx.workspaceId, t.ctx.userId, flowId);
        const result = withoutPins(withPins(draft.flow, pins).nodes, Array.isArray(nodeId) ? nodeId : [nodeId]);
        const said = {
            ...(result.notPinned.length ? { notPinned: result.notPinned } : {}),
            ...(result.notFound.length ? { notFound: result.notFound } : {}),
        };
        if (result.unpinned.length === 0) {
            return ok({ unpinned: [], ...said, message: 'Nothing was pinned there.' });
        }

        await removePins(t.ctx, flowId, result.unpinned);
        return ok({ unpinned: result.unpinned, ...said, ...t.flowLink(flow.projectId, flowId) });
    },
});
