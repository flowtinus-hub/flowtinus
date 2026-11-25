import { emergencyRollbacks } from '#features/deployments/deployments';
import { endsEmergencyRollbackByAccident, endsRollbackMessage } from '#features/deployments/emergency-rollback/emergency-rollback-content';
import type { Database } from '#shared/database/database';
import { flowsIn, type FlowState } from './environments';
import type { PreflightWarning } from './promotion-edge';
import type { FlowImpact } from './promotions';
import type { RepoFiles } from './workspace-export';

export type FlowAfter = { name: string; state: FlowState | null };

export async function rollbacksEndedByAccident(db: Database, workspaceId: string, flows: Map<string, FlowAfter>): Promise<string[]> {
    const rollbacks = new Map((await emergencyRollbacks(db, workspaceId)).map(r => [r.flowId, r]));
    return [...flows]
        .filter(([id, { state }]) => {
            const rollback = rollbacks.get(id);
            return !!rollback && endsEmergencyRollbackByAccident(rollback, state);
        })
        .map(([, flow]) => flow.name)
        .sort();
}

export function flowsAfterMerge(before: RepoFiles, after: RepoFiles, handle: string): Map<string, FlowAfter> {
    const was = flowsIn(before, handle);
    const now = flowsIn(after, handle);
    const flows = new Map<string, FlowAfter>();
    for (const [id, state] of was) {
        flows.set(id, { name: state.name, state: null });
    }
    for (const [id, state] of now) {
        flows.set(id, { name: state.name, state });
    }
    return flows;
}

export async function endsRollbackWarning(
    db: Database,
    workspaceId: string,
    flows: Map<string, FlowAfter>,
    environment: string,
): Promise<PreflightWarning[]> {
    const names = await rollbacksEndedByAccident(db, workspaceId, flows);
    return names.length > 0 ? [{ kind: 'ends-emergency-rollback', message: endsRollbackMessage(names, environment), items: names }] : [];
}

/** a promotion out of this environment takes git's version of a flow, never the one an emergency rollback runs here */
export async function promotedRollbacksWarning(
    db: Database,
    workspaceId: string,
    impact: FlowImpact[],
    environment: string,
): Promise<PreflightWarning[]> {
    const rolledBack = new Set((await emergencyRollbacks(db, workspaceId)).map(r => r.flowId));
    const names = impact
        .filter(flow => rolledBack.has(flow.id) && flow.changes.some(change => change === 'added' || change === 'changed'))
        .map(flow => flow.name);
    if (names.length === 0) {
        return [];
    }
    const message =
        names.length === 1
            ? `${names[0]} is in an emergency rollback on ${environment}: this promotion carries git's version of it, not the one that runs here.`
            : `In an emergency rollback on ${environment}: this promotion carries git's version of these flows, not the ones that run here.`;
    return [{ kind: 'emergency-rollback', message, items: names }];
}
