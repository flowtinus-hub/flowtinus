import { z } from 'zod';
import { GetProjectHandler } from '#features/projects/get-project/get-project-handler';
import { defineTool, failed, id, ok } from './tool';

export const validateFlow = defineTool({
    name: 'validate_flow',
    scope: 'catalog:read',
    description:
        'Checks a flow file (YAML) without saving it: every issue at once with its nodeId, settingKey or port, plus warnings (allowed, but probably a mistake). Also checks the project: the flows a Flow Invoker calls, the connections, secrets and scripts named. A connection profile or secret the workspace does not have yet (by id, or a dynamic connection name its parameters and variables give) is a warning, not an issue: a person creates it in the editor; the draft can be saved meanwhile, and the run fails at that component until it exists. Fix the issues and call again until ok is true.',
    input: {
        projectId: id('the project the flow is (or will be) in'),
        yaml: z.string().describe('the flow file, YAML (or JSON)'),
        flowId: id('the flow it will be saved as, when it exists (a Flow Invoker cannot call it)').optional(),
    },
    run: async ({ projectId, yaml, flowId }, t) => {
        const project = await new GetProjectHandler().handle({ id: projectId }, t.ctx);
        if (!project.ok) {
            return failed(project.error);
        }
        const { ok: valid, issues, warnings } = await t.check(projectId, yaml, flowId);
        return ok({ ok: valid, issues, warnings });
    },
});
