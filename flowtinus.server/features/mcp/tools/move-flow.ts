import { z } from 'zod';
import { MoveFlowHandler } from '#features/flows/move-flow/move-flow-handler';
import { answer, defineTool, id } from './tool';

export const moveFlow = defineTool({
    name: 'move_flow',
    scope: 'flows:write',
    description: 'Moves a flow to another folder of its project (folderId null: the root).',
    input: { flowId: id('the flow'), folderId: z.string().nullable().describe('the folder, or null for the root') },
    annotations: { destructiveHint: false, idempotentHint: true },
    editsBranch: true,
    run: async ({ flowId, folderId }, t) =>
        answer(await new MoveFlowHandler().handle({ id: flowId, folderId }, t.ctx), f => ({ flowId: f.id, folderId: f.folderId })),
});
