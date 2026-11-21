import { ListScriptsHandler } from '#features/scripts/scripts-handlers';
import { defineTool, failed, id, ok } from './tool';

export const listScriptsTool = defineTool({
    name: 'list_scripts',
    scope: 'flows:read',
    description:
        "A project's scripts: path, import path (what code of any project of the workspace imports it by) and what each exports (functions a Script Invoker calls as <import path>#name, types a Start takes as its input type).",
    input: { projectId: id('the project') },
    run: async ({ projectId }, t) => {
        const listed = await new ListScriptsHandler().handle({ projectId }, t.ctx);
        if (!listed.ok) {
            return failed(listed.error);
        }
        return ok({ scripts: listed.value.scripts.map(s => ({ path: s.path, importPath: s.importPath, exports: s.exports ?? [] })) });
    },
});
