import { z } from 'zod';
import { GetScriptHandler } from '#features/scripts/scripts-handlers';
import { answer, defineTool, id } from './tool';

export const getScript = defineTool({
    name: 'get_script',
    scope: 'flows:read',
    description:
        "A project script's code (TypeScript), with the revision save_script needs. Flows use it through a TypeScript component (import from '@myproject/scripts/<path>'), a Script Invoker (path#function) or a Start's input type (path#Type).",
    input: { projectId: id('the project'), path: z.string().describe('the script, as list_scripts gives it (folders/name, no .ts)') },
    run: async ({ projectId, path }, t) => answer(await new GetScriptHandler().handle({ projectId, path }, t.ctx)),
});
