import { ListProjectsHandler } from '#features/projects/list-projects/list-projects-handler';
import { answer, defineTool, workspaceArg } from './tool';

export const listProjects = defineTool({
    name: 'list_projects',
    scope: 'flows:read',
    description:
        "A workspace's active projects: id, name, handle (its name in import paths), description and how many flows each has. Ask the user which one when it is not clear.",
    input: { workspace: workspaceArg },
    run: async (_args, t) =>
        answer(await new ListProjectsHandler().handle({}, t.ctx), v =>
            v.items.map(p => ({
                id: p.id,
                name: p.name,
                handle: p.handle,
                description: p.description,
                summary: p.summary,
                ...t.link(`/projects/${p.id}/flows`),
            })),
        ),
});
