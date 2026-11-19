import { z } from 'zod';
import { CreateProjectHandler } from '#features/projects/create-project/create-project-handler';
import { answer, defineTool, workspaceArg } from './tool';

export const createProject = defineTool({
    name: 'create_project',
    scope: 'projects:write',
    description: 'Creates a project in a workspace (an editor or admin of it). Only when the user asked for a new one.',
    input: {
        workspace: workspaceArg,
        name: z.string().describe('its name, unique in the workspace'),
        description: z.string().optional().describe('what it is for'),
    },
    annotations: { destructiveHint: false },
    editsBranch: true,
    run: async ({ name, description }, t) =>
        answer(await new CreateProjectHandler().handle({ name, ...(description ? { description } : {}) }, t.ctx), (p: { id: string }) => ({
            projectId: p.id,
            ...t.link(`/projects/${p.id}/flows`),
        })),
});
