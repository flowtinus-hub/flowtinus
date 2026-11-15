import { ArchiveFlowHandler } from '#features/flows/archive-flow/archive-flow-handler';
import { defineTool, failed, id, logApproval, ok, userApproval } from './tool';

/*
 * The editor's Archive of a flow (only a flow: never a folder or a project), through the MCP. The same guards as
 * run_for_real: its own scope, flows:archive (flows:write is not enough), and userApproval, the user's own words.
 */
export const archiveFlow = defineTool({
    name: 'archive_flow',
    scope: 'flows:archive',
    description:
        "Archives a flow, as the editor's Archive does: it leaves the flow lists, and when it is deployed it is undeployed (its schedules and webhooks stop, the Flow Invokers that call it fail). A person can restore it from the editor's Archived list. Only one flow: never a folder or a project. " +
        'ONLY call this after the user explicitly authorized archiving this flow in this conversation (e.g. "archive the flow X", "archive it"). ' +
        'Cleaning up, reorganizing or "remove what is not used" is NOT that authorization, nor is an authorization given for another flow. ' +
        'When the user did not say it explicitly, do not call it: ask the user ("Can I archive <flow>? It is deployed: its schedules stop") or say that archiving needs their explicit approval. ' +
        "userApproval must quote the user's message that authorized it, word for word; never write it yourself. Check get_deployments and get_flow_calls first and tell the user what stops.",
    input: {
        flowId: id('the flow'),
        userApproval: userApproval('archiving this flow'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run: async ({ flowId, userApproval: approval }, t) => {
        const found = await t.flowAndDraft(flowId);
        if (!found.ok) {
            return failed(found.error);
        }
        const archived = await new ArchiveFlowHandler().handle({ id: flowId }, t.ctx);
        if (!archived.ok) {
            return failed(archived.error);
        }
        const { flow } = found.value;
        logApproval('archive_flow', `flow ${flowId} (${flow.name}) archived`, t.ctx, approval);
        return ok({ flowId, name: flow.name, archived: true, userApproval: approval });
    },
});
