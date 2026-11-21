import { membershipsOf } from '#features/workspaces/memberships';
import { defineTool, ok } from './tool';

export const listWorkspaces = defineTool({
    name: 'list_workspaces',
    scope: 'flows:read',
    description:
        "The user's workspaces: handle (what the other tools take as `workspace`), name and the user's role (viewer reads; editor also writes and runs; admin also manages the workspace). A workspace holds projects and, for all of them, connection profiles, secrets and variables. Ask the user which one when it is not clear.",
    input: {},
    run: async (_args, t) =>
        ok(
            (await membershipsOf(t.ctx.db, t.ctx.userId)).map(w => ({
                workspace: w.handle,
                name: w.name,
                role: w.role,
                ...t.link(`/w/${w.handle}/projects`),
            })),
        ),
});
