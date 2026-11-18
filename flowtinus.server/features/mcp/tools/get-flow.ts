import { z } from 'zod';
import { flowToYaml } from '@flowtinus/core';
import { pinsOf, withPins } from '#features/pins/pins';
import { defineTool, failed, id, MAX_YAML_BYTES, ok } from './tool';

export const getFlow = defineTool({
    name: 'get_flow',
    scope: 'flows:read',
    description:
        "A flow's draft as a flow file (YAML), with the revision save_draft needs, its project and worker tag. Pinned outputs (a component's saved sample, replayed by test runs) are the token's user's own, not the draft's: left out unless includePinned (save_draft ignores them; pin_from_run and unpin change them).",
    input: {
        flowId: id('the flow, from get_project_contents or resolve_url'),
        includePinned: z.boolean().default(false).describe('include your pinned outputs (can be large)'),
    },
    run: async ({ flowId, includePinned }, t) => {
        const found = await t.flowAndDraft(flowId);
        if (!found.ok) {
            return failed(found.error);
        }
        const { flow, draft } = found.value;
        const pins = await pinsOf(t.ctx.db, t.ctx.workspaceId, t.ctx.userId, flow.id);
        const pinnedNodes = draft.flow.nodes.filter(n => pins[n.id]).map(n => n.id);
        const yaml = flowToYaml(includePinned ? withPins(draft.flow, pins) : draft.flow);
        if (Buffer.byteLength(yaml) > MAX_YAML_BYTES) {
            return failed({
                code: 'validation',
                message: `The flow file takes more than ${MAX_YAML_BYTES / 1024} KB${includePinned ? ': ask without includePinned' : ''}.`,
            });
        }
        return ok({
            flowId: flow.id,
            projectId: flow.projectId,
            folderId: flow.folderId,
            name: flow.name,
            workerTag: flow.workerTag,
            revision: draft.revision,
            ...(pinnedNodes.length && !includePinned ? { pinnedNodes } : {}),
            yaml,
            ...t.flowLink(flow.projectId, flow.id),
        });
    },
});
