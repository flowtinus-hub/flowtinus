import { GetProjectHandler } from '#features/projects/get-project/get-project-handler';
import { listScripts } from '#features/scripts/script-store';
import { defineTool, failed, id, ok } from './tool';

export const listScriptsTool = defineTool({
    name: 'list_scripts',
    scope: 'flows:read',
    description:
        "A project's scripts: path and what each exports (functions a Script Invoker calls as path#name, types a Start takes as its input type).",
    input: { projectId: id('the project') },
    run: async ({ projectId }, t) => {
        const project = await new GetProjectHandler().handle({ id: projectId }, t.ctx);
        if (!project.ok) {
            return failed(project.error);
        }
        const { scripts } = await listScripts(t.ctx.db, t.ctx.workspaceId, projectId);
        return ok({ scripts: scripts.map(s => ({ path: s.path, exports: s.exports ?? [] })) });
    },
});
