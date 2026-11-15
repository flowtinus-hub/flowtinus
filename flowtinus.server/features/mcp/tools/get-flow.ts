import { z } from 'zod';
import { flowToYaml, type FlowFile } from '@flowtinus/core';
import { defineTool, failed, id, MAX_YAML_BYTES, ok } from './tool';

export const getFlow = defineTool({
    name: 'get_flow',
    scope: 'flows:read',
    description:
        "A flow's draft as a flow file (YAML), with the revision save_draft needs, its project and worker tag. Pinned outputs (a component's saved sample, replayed by test runs) are left out unless includePinned: save_draft keeps them on the nodes that come without one.",
    input: {
        flowId: id('the flow, from get_project_contents or resolve_url'),
        includePinned: z.boolean().default(false).describe('include the pinned outputs (can be large)'),
    },
    run: async ({ flowId, includePinned }, t) => {
        const found = await t.flowAndDraft(flowId);
        if (!found.ok) {
            return failed(found.error);
        }
        const { flow, draft } = found.value;
        const pinnedNodes = draft.flow.nodes.filter(n => n.pinned).map(n => n.id);
        const file: FlowFile = includePinned
            ? draft.flow
            : { ...draft.flow, nodes: draft.flow.nodes.map(({ pinned: _pinned, ...n }) => n) };
        const yaml = flowToYaml(file);
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
