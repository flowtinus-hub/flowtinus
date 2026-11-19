import { z } from 'zod';
import { COMPONENT_TYPE, callCycles, flowCalls, flowScriptUses, folderPath, isFolderVisible, scriptLinks, toExecutableFlow, type FlowCall, type ScriptUse } from '@flowtinus/core';
import { loadDraft } from '#features/flows/flow-draft';
import { workingScripts } from '#features/scripts/script-store';
import { loadTree } from '#features/folders/project-tree';
import { GetProjectHandler } from '#features/projects/get-project/get-project-handler';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';

export const GetFlowCallsQuery = z.object({ projectId: z.uuid('Invalid') });

export type CalledFlowView = { id: string; name: string; folder: string; available: boolean };

export type FlowCallsResponse = {
    flows: CalledFlowView[];
    calls: FlowCall[];
    cycles: string[][];
    scripts: string[];
    scriptUses: ScriptUse[];
    scriptImports: { from: string; to: string }[];
};

export class GetFlowCallsHandler implements UseCaseHandler<FlowCallsResponse> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowCallsResponse>> {
        const parsed = validate(GetFlowCallsQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const project = await new GetProjectHandler().handle({ id: parsed.value.projectId }, ctx);
        if (!project.ok) {
            return project;
        }

        const tree = await loadTree(ctx.db, ctx.workspaceId, parsed.value.projectId);
        const available = (row: (typeof tree.flows)[number]) => !row.archivedAt && isFolderVisible(tree.folders, row.folderId);
        const flows = tree.flows.map(row => ({
            id: row.id,
            name: row.name,
            folder: row.folderId
                ? folderPath(tree.folders, row.folderId)
                      .map(f => f.name)
                      .join(' / ')
                : '',
            available: available(row),
        }));
        const DEFAULT_NAMES: Record<string, string> = {
            [COMPONENT_TYPE.flowInvoker]: 'Flow Invoker',
            [COMPONENT_TYPE.start]: 'Start',
            [COMPONENT_TYPE.typescript]: 'TypeScript',
        };
        const named = (label: string | undefined) => (label !== undefined && DEFAULT_NAMES[label]) || label;
        const active: ReturnType<typeof toExecutableFlow>[] = [];
        for (const row of tree.flows.filter(available)) {
            active.push(toExecutableFlow((await loadDraft(ctx.db, ctx.workspaceId, row)).flow, project.value.name));
        }
        const scripts = await workingScripts(ctx.db, ctx.workspaceId, parsed.value.projectId);
        const calls = flowCalls(active).map(c => ({
            ...c,
            nodeLabel: named(c.nodeLabel)!,
            ...(c.onErrorOfLabel ? { onErrorOfLabel: named(c.onErrorOfLabel) } : {}),
        }));
        const scriptUses = flowScriptUses(active).map(u => ({ ...u, nodeLabel: named(u.nodeLabel)! }));
        return success({
            flows,
            calls,
            cycles: callCycles(calls),
            scripts: scripts.map(s => s.path),
            scriptUses,
            scriptImports: scriptLinks(scripts),
        });
    }
}
