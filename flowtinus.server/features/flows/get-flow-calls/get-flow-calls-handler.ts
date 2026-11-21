import { branchDraft, branchFlow, branchTree, workBranch } from '#features/git/branch-read';
import { z } from 'zod';
import { COMPONENT_TYPE, callCycles, flowCalls, flowScriptUses, folderPath, isFolderVisible, scriptLinks, toExecutableFlow, type FlowCall, type ScriptUse } from '@flowtinus/core';
import { loadDraft } from '#features/flows/flow-draft';
import { contentsIn, editingSource, importPathIn, scriptScope } from '#features/scripts/script-store';
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

        const branch = await workBranch(ctx);
        const tree = branch ? branchTree(branch, parsed.value.projectId) : await loadTree(ctx.db, ctx.workspaceId, parsed.value.projectId);
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
            const draft = branch ? branchDraft(branchFlow(branch, row.id)!).flow : (await loadDraft(ctx.db, ctx.workspaceId, row)).flow;
            active.push(toExecutableFlow(draft, project.value.name));
        }
        const source = editingSource(branch);
        const scope = await scriptScope(ctx.db, ctx.workspaceId, source);
        const prefix = importPathIn(scope, parsed.value.projectId, '');
        const shown = (importPath: string) => (importPath.startsWith(prefix) ? importPath.slice(prefix.length) : importPath);
        const scripts = await contentsIn(ctx.db, ctx.workspaceId, source, scope);
        const calls = flowCalls(active).map(c => ({
            ...c,
            nodeLabel: named(c.nodeLabel)!,
            ...(c.onErrorOfLabel ? { onErrorOfLabel: named(c.onErrorOfLabel) } : {}),
        }));
        const uses = flowScriptUses(active);
        const links = scriptLinks(scripts);
        const reached = new Set([...scripts.filter(s => s.path.startsWith(prefix)).map(s => s.path), ...uses.map(u => u.path)]);
        for (const path of reached) {
            links.filter(l => l.from === path).forEach(l => reached.add(l.to));
        }
        const scriptUses = uses.map(u => ({ ...u, path: shown(u.path), nodeLabel: named(u.nodeLabel)! }));
        return success({
            flows,
            calls,
            cycles: callCycles(calls),
            scripts: scripts.filter(s => reached.has(s.path)).map(s => shown(s.path)),
            scriptUses,
            scriptImports: links.filter(l => reached.has(l.from)).map(l => ({ from: shown(l.from), to: shown(l.to) })),
        });
    }
}
