import { z } from 'zod';
import { GetDraftHandler } from '#features/flows/get-draft/get-draft-handler';
import { SaveDraftHandler } from '#features/flows/save-draft/save-draft-handler';
import { defineTool, failed, id, ok } from './tool';

export const saveDraft = defineTool({
    name: 'save_draft',
    scope: 'flows:write',
    description:
        "Saves a flow file as a flow's draft (what the editor shows and its Run runs; nothing is deployed). Validated first, like validate_flow: refused with the issues when not valid; saved with warnings (e.g. a connection the workspace does not have yet) when only those. expectedRevision is the revision get_flow (or the last save) gave: when someone saved in between, it is refused (conflict) with the current revision; read the flow again, never overwrite a person's change. Pinned outputs are not the draft's: a pinned in the yaml is ignored, the user's pins stay (pin_from_run and unpin change them).",
    input: {
        flowId: id('the flow'),
        yaml: z.string().describe('the whole flow file'),
        expectedRevision: z.number().int().min(0).describe('the revision the yaml was based on'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    editsBranch: true,
    run: async ({ flowId, yaml, expectedRevision }, t) => {
        const found = await t.flowAndDraft(flowId);
        if (!found.ok) {
            return failed(found.error);
        }
        const { flow, draft } = found.value;
        if (draft.revision !== expectedRevision) {
            return failed({
                code: 'conflict',
                message: 'The draft changed since it was read: read it again with get_flow and apply the change to it.',
                currentRevision: draft.revision,
            });
        }
        const checked = await t.check(flow.projectId, yaml, flowId);
        if (!checked.ok || !checked.flow) {
            return t.invalid(checked);
        }
        const saved = await new SaveDraftHandler().handle({ id: flowId, revision: expectedRevision, flow: checked.flow }, t.ctx);
        if (!saved.ok) {
            const now = await new GetDraftHandler().handle({ id: flowId }, t.ctx);
            return failed({
                ...saved.error,
                ...(saved.error.code === 'conflict' && now.ok ? { currentRevision: now.value.revision } : {}),
            });
        }
        return ok({ revision: saved.value.revision, warnings: checked.warnings, ...t.flowLink(flow.projectId, flowId) });
    },
});
