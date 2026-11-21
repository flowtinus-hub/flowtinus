import { validateFlowFile, type FlowFile } from '@flowtinus/core';
import type { Database } from '#shared/database/database';
import { loadTree } from '#features/folders/project-tree';
import { hasLiveSupervisor, noSupervisorFor } from '#features/supervisors/supervisors';
import { checkedInput } from './start-run/start-run-handler';
import { runSnapshot } from './start-run/run-snapshot';
import { runs } from './run';

export type DeployedTarget = {
    workspaceId: string;
    projectId: string;
    flowId: string;
    flowName: string;
    workerTag: string;
    versionId: string;
    definition: FlowFile;
};

export type DeployedRun =
    { ok: true; values: typeof runs.$inferInsert } | { ok: false; reason: 'flow' | 'input' | 'worker'; error: string };

export async function deployedRun(
    db: Database,
    target: DeployedTarget,
    trigger: 'schedule' | 'webhook',
    parameters: Record<string, string>,
    given: unknown,
): Promise<DeployedRun> {
    const checked = validateFlowFile({ ...target.definition, id: target.flowId, name: target.flowName });
    if (!checked.ok) {
        return { ok: false, reason: 'flow', error: `The flow cannot run: ${checked.errors.join(' ')}` };
    }

    const ctx = { db, workspaceId: target.workspaceId, userId: trigger };
    const tree = await loadTree(db, target.workspaceId, target.projectId);
    const snapshot = await runSnapshot(ctx, tree, checked.value, 'deployed');
    if (!snapshot.ok) {
        return { ok: false, reason: 'flow', error: `The flow cannot run: ${snapshot.error}` };
    }

    const input = await checkedInput(ctx, checked.value, given);
    if (!input.ok) {
        return { ok: false, reason: 'input', error: input.error };
    }

    if (!(await hasLiveSupervisor(db, target.workerTag))) {
        return { ok: false, reason: 'worker', error: noSupervisorFor(target.workerTag) };
    }

    return {
        ok: true,
        values: {
            id: crypto.randomUUID(),
            workspaceId: target.workspaceId,
            flowId: target.flowId,
            projectId: target.projectId,
            mode: 'execution',
            flowVersionId: target.versionId,
            status: 'queued',
            trigger,
            workerTag: target.workerTag,
            parameters,
            ...(input.input !== undefined ? { input: input.input } : {}),
            definition: checked.value,
            scripts: snapshot.scripts,
            calledFlows: snapshot.calledFlows.length ? snapshot.calledFlows : null,
            flowName: target.flowName,
        },
    };
}
