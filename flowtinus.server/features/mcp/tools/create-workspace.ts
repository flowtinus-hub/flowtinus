import { z } from 'zod';
import { CreateWorkspaceHandler } from '#features/workspaces/workspaces-handlers';
import { answer, defineTool } from './tool';

export const createWorkspace = defineTool({
    name: 'create_workspace',
    scope: 'workspaces:write',
    description:
        'Creates a workspace; its creator becomes its admin. Only an admin of the environment may, and only when the user asked for a new one.',
    input: {
        handle: z
            .string()
            .describe('its id in the addresses (/w/<handle>/...): lowercase letters, digits and hyphens, unique; it never changes'),
        name: z.string().describe('its name'),
        description: z.string().optional().describe('what it is for'),
    },
    annotations: { destructiveHint: false },
    run: async ({ handle, name, description }, t) =>
        answer(await new CreateWorkspaceHandler().handle({ handle, name, ...(description ? { description } : {}) }, t.ctx), w => ({
            workspace: w.handle,
            ...t.link(`/w/${w.handle}/projects`),
        })),
});
