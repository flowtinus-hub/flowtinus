import { COMPONENT_TYPE, dynamicTargets, flowPath, inputTypeRef, isFolderVisible, MAX_FLOW_DEPTH, scriptTypeShape, START, startConfig, validateFlowFile, DYNAMIC_TARGET, type FlowFile, type TypeShape } from '@flowtinus/core';
import { deployedDefinitions } from '#features/deployments/deployments';
import { loadDraft } from '#features/flows/flow-draft';
import type { ProjectTree } from '#features/folders/project-tree';
import { typeSources } from '#features/scripts/script-store';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';

export type CalledFlow = {
    id: string;
    name: string;
    path?: string;
    flow?: FlowFile;
    versionId?: string;
    inputType?: { name: string; shape: TypeShape };
    unavailable?: string;
    /** its own worker tag: a fire and forget run of it goes to the supervisors of that tag */
    workerTag?: string;
    /** taken only because a Flow Invoker names its flow by expression (any flow could be): its problems do not stop the run */
    anyFlow?: true;
};

export const callsOf = (file: FlowFile) =>
    file.nodes
        .filter(
            n =>
                n.type === COMPONENT_TYPE.flowInvoker &&
                typeof n.config.flowId === 'string' &&
                n.config.flowId !== '' &&
                n.config.flowId !== DYNAMIC_TARGET,
        )
        .map(n => n.config.flowId as string);

async function inputTypeOf(
    ctx: UseCaseContext,
    projectId: string,
    file: FlowFile,
): Promise<{ type?: CalledFlow['inputType']; error?: string }> {
    const config = file.nodes.find(n => n.type === START)?.config ?? {};
    const ref = startConfig(config).acceptsInput ? inputTypeRef(config.inputType) : null;
    if (!ref) {
        return {};
    }

    const shape = scriptTypeShape(await typeSources(ctx.db, ctx.workspaceId, projectId, ref.path), ref.path, ref.name);
    return shape
        ? { type: { name: ref.name, shape } }
        : { error: `its input type ${ref.name} no longer exists in the script ${ref.path}.` };
}

export async function calledFlows(
    ctx: UseCaseContext,
    projectId: string,
    tree: ProjectTree,
    root: FlowFile,
    source: 'draft' | 'deployed',
): Promise<CalledFlow[]> {
    const found = new Map<string, CalledFlow>();
    const deployed =
        source === 'deployed'
            ? await deployedDefinitions(
                  ctx.db,
                  ctx.workspaceId,
                  tree.flows.map(f => f.id),
              )
            : null;
    const active = (id: string) => {
        const row = tree.flows.find(f => f.id === id);
        return row && !row.archivedAt && isFolderVisible(tree.folders, row.folderId) ? row : undefined;
    };
    const take = async (id: string): Promise<string[]> => {
        const row = active(id);
        if (!row) {
            found.set(id, {
                id,
                name: tree.flows.find(f => f.id === id)?.name ?? id,
                unavailable: 'it was not found (archived or removed).',
            });
            return [];
        }

        const path = flowPath(tree.folders, row);
        const version = deployed?.get(id);
        if (deployed && !version) {
            found.set(id, { id, name: row.name, path, workerTag: row.workerTag, unavailable: 'it is not deployed.' });
            return [];
        }

        const checked = validateFlowFile(
            version ? { ...version.definition, id: row.id, name: row.name } : (await loadDraft(ctx.db, ctx.workspaceId, row)).flow,
        );
        if (!checked.ok) {
            found.set(id, { id, name: row.name, path, unavailable: checked.errors.join(' ') });
            return [];
        }

        const { type, error } = await inputTypeOf(ctx, projectId, checked.value);
        found.set(id, {
            id,
            name: row.name,
            path,
            flow: checked.value,
            ...(version ? { versionId: version.versionId } : {}),
            workerTag: row.workerTag,
            ...(type ? { inputType: type } : {}),
            ...(error ? { unavailable: error } : {}),
        });
        return callsOf(checked.value);
    };

    let level = callsOf(root);
    for (let depth = 1; depth <= MAX_FLOW_DEPTH && level.length > 0; depth++) {
        const next: string[] = [];
        for (const id of new Set(level)) {
            if (!found.has(id) && id !== root.id) {
                next.push(...(await take(id)));
            }
        }

        level = next;
    }

    const byExpression = [root, ...[...found.values()].flatMap(c => (c.flow ? [c.flow] : []))].some(
        file => dynamicTargets(file.nodes).flows,
    );
    if (byExpression) {
        for (const row of tree.flows) {
            if (row.id !== root.id && !found.has(row.id) && active(row.id)) {
                await take(row.id);
                found.set(row.id, { ...found.get(row.id)!, anyFlow: true });
            }
        }

        const self = root.id ? active(root.id) : undefined;
        if (self) {
            found.set(self.id, {
                id: self.id,
                name: self.name,
                path: flowPath(tree.folders, self),
                unavailable: 'it is the flow that runs (a call to it is circular).',
            });
        }
    }

    return [...found.values()];
}
