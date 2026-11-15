import { z } from 'zod';
import { scriptExports } from '@flowtinus/core';
import { CreateScriptPathHandler, GetScriptHandler, SaveScriptHandler } from '#features/scripts/scripts-handlers';
import { defineTool, failed, id, ok } from './tool';

function syntaxError(code: string): string | null {
    try {
        new Bun.Transpiler({ loader: 'ts' }).transformSync(code);
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

export const saveScript = defineTool({
    name: 'save_script',
    scope: 'flows:write',
    description:
        "Creates a project script (TypeScript) or replaces its code. A new one: no expectedRevision. An existing one: expectedRevision is the revision get_script (or the last save) gave; when someone saved in between it is refused (conflict) with the current revision, never overwriting a person's change. The code is checked for syntax first (refused when it does not compile). Answers the revision and what the script exports. A change applies to every flow that uses the script, deployed ones included.",
    input: {
        projectId: id('the project'),
        path: z.string().describe("folders/name, no .ts (e.g. 'pricing/tax'); new folders are made as needed"),
        content: z.string().describe("the whole code: export functions (a Script Invoker calls them) and types (a Start's input type)"),
        expectedRevision: z.number().int().min(0).optional().describe('the revision it was based on; omit to create a new script'),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
    run: async ({ projectId, path, content, expectedRevision }, t) => {
        const error = syntaxError(content);
        if (error) {
            return failed({ code: 'validation', message: `The script does not compile: ${error}. Nothing was saved.` });
        }
        const current = await new GetScriptHandler().handle({ projectId, path }, t.ctx);
        const exports = scriptExports(content);

        if (expectedRevision === undefined) {
            if (current.ok) {
                return failed({
                    code: 'conflict',
                    message: 'This script already exists: read it with get_script and save with its revision.',
                    currentRevision: current.value.revision,
                });
            }
            const created = await new CreateScriptPathHandler().handle({ projectId, path, kind: 'script', content }, t.ctx);
            return created.ok ? ok({ path: created.value.path, revision: created.value.revision, exports }) : failed(created.error);
        }

        if (!current.ok) {
            return failed(current.error);
        }
        const saved = await new SaveScriptHandler().handle({ projectId, path, content, revision: expectedRevision }, t.ctx);
        if (!saved.ok) {
            const now = await new GetScriptHandler().handle({ projectId, path }, t.ctx);
            return failed({
                ...saved.error,
                ...(saved.error.code === 'conflict' && now.ok ? { currentRevision: now.value.revision } : {}),
            });
        }
        return ok({ path: current.value.path, revision: saved.value.revision, exports });
    },
});
