import { z } from 'zod';
import { RenameFlowHandler } from '#features/flows/rename-flow/rename-flow-handler';
import { answer, defineTool, id } from './tool';

export const renameFlow = defineTool({
    name: 'rename_flow',
    scope: 'flows:write',
    description: 'Renames a flow.',
    input: { flowId: id('the flow'), name: z.string().describe('the new name, unique in its folder') },
    annotations: { destructiveHint: false, idempotentHint: true },
    editsBranch: true,
    run: async ({ flowId, name }, t) =>
        answer(await new RenameFlowHandler().handle({ id: flowId, name }, t.ctx), f => ({ flowId: f.id, name: f.name })),
});
