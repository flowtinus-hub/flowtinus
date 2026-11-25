import { emergencyRollbackHashes } from '#features/deployments/deployments';
import type { Database } from '#shared/database/database';
import { flowsIn, type FlowState } from './environments';
import type { PreflightWarning } from './promotion-edge';
import type { FlowImpact } from './promotions';
import type { RepoFiles } from './workspace-export';

/** a flow a change brings into this environment: its state after the change, null when the change removes it */
export type FlowAfter = { name: string; state: FlowState | null };

const runs = (state: FlowState | null, hash: string) => !!state?.deployed && state.hash === hash;

/**
 * The flows in an emergency rollback that a change ends by accident: any other content ends it, except git's version
 * (no change of the flow) and what runs (the fix).
 */
export async function rollbacksEndedByAccident(db: Database, workspaceId: string, flows: Map<string, FlowAfter>): Promise<string[]> {
    const rollbacks = await emergencyRollbackHashes(db, workspaceId);
    return [...flows]
        .filter(([id, { state }]) => {
            const rollback = rollbacks.get(id);
            return !!rollback && !runs(state, rollback.git) && !runs(state, rollback.runs);
        })
        .map(([, flow]) => flow.name)
        .sort();
}

export const endsRollbackMessage = (names: string[], environment: string) =>
    `This ends the emergency rollback of ${names.join(', ')} on ${environment}.`;

/** the flows of a merge into this environment's branch, as it leaves them */
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
    const rollbacks = await emergencyRollbackHashes(db, workspaceId);
    const names = impact
        .filter(flow => rollbacks.has(flow.id) && flow.changes.some(change => change === 'added' || change === 'changed'))
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
