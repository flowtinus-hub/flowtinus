import { GetFlowCallsHandler } from '#features/flows/get-flow-calls/get-flow-calls-handler';
import { GetFlowHandler } from '#features/flows/get-flow/get-flow-handler';
import { defineTool, failed, id, ok } from './tool';

export const getFlowCalls = defineTool({
    name: 'get_flow_calls',
    scope: 'flows:read',
    description:
        'Which flows a flow calls (its Flow Invokers) and which flows call it, from the drafts, with any circular chain it is part of.',
    input: { flowId: id('the flow') },
    run: async ({ flowId }, t) => {
        const flow = await new GetFlowHandler().handle({ id: flowId }, t.ctx);
        if (!flow.ok) {
            return failed(flow.error);
        }
        const result = await new GetFlowCallsHandler().handle({ projectId: flow.value.projectId }, t.ctx);
        if (!result.ok) {
            return failed(result.error);
        }
        const names = new Map(result.value.flows.map(f => [f.id, f.name]));
        const call = (c: (typeof result.value.calls)[number]) => ({
            from: c.from,
            fromName: names.get(c.from),
            to: c.to,
            toName: names.get(c.to),
            nodeId: c.nodeId,
            nodeLabel: c.nodeLabel,
            ...(c.onErrorOf ? { onErrorOf: c.onErrorOf } : {}),
        });
        return ok({
            calls: result.value.calls.filter(c => c.from === flowId).map(call),
            calledBy: result.value.calls.filter(c => c.to === flowId).map(call),
            cycles: result.value.cycles.filter(cycle => cycle.includes(flowId)).map(cycle => cycle.map(each => names.get(each) ?? each)),
        });
    },
});
