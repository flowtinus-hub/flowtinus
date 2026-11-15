import { z } from 'zod';
import { CreateFlowHandler } from '#features/flows/create-flow/create-flow-handler';
import { SaveDraftHandler } from '#features/flows/save-draft/save-draft-handler';
import { GetProjectHandler } from '#features/projects/get-project/get-project-handler';
import { defineTool, failed, id, ok } from './tool';

export const createFlow = defineTool({
    name: 'create_flow',
    scope: 'flows:write',
    description:
        'Creates a flow (in a folder with folderId) and, with yaml, saves it as its draft: the yaml is validated first (the answer of validate_flow), and nothing is created when it is not valid. Answers the flowId and the revision for the next save_draft.',
    input: {
        projectId: id('the project'),
        name: z.string().describe('its name, unique in its folder'),
        folderId: id('the folder; omit for the root').optional(),
        yaml: z.string().optional().describe('its first draft (a flow file); without it the flow has only a Start and an End'),
    },
    annotations: { destructiveHint: false },
    run: async ({ projectId, name, folderId, yaml }, t) => {
        if (yaml !== undefined) {
            const project = await new GetProjectHandler().handle({ id: projectId }, t.ctx);
            if (!project.ok) {
                return failed(project.error);
            }
            const checked = await t.check(projectId, yaml);
            if (!checked.ok) {
                return t.invalid(checked);
            }
        }
        const created = await new CreateFlowHandler().handle({ projectId, name, folderId: folderId ?? null }, t.ctx);
        if (!created.ok) {
            return failed(created.error);
        }
        const flowId = created.value.id;
        if (yaml === undefined) {
            return ok({ flowId, revision: 0, ...t.flowLink(projectId, flowId) });
        }
        const checked = await t.check(projectId, yaml, flowId);
        const saved = await new SaveDraftHandler().handle({ id: flowId, revision: 0, flow: checked.flow }, t.ctx);
        return saved.ok
            ? ok({ flowId, revision: saved.value.revision, warnings: checked.warnings, ...t.flowLink(projectId, flowId) })
            : failed({ ...saved.error, message: `The flow was created (${flowId}), but its draft was not saved: ${saved.error.message}` });
    },
});
