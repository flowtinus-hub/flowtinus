import type { Flow } from '#features/flows/flow';
import { commitFlows } from '#features/git/git-first';
import type { FlowToCommit } from '#features/git/workspace-export';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { success, type UseCaseError, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { loadDeployments, lockFlowDeployments, type FlowDeploymentsView } from './deployments';

export type CommittedDeployments = FlowDeploymentsView & { commit?: string };

/**
 * With git on, a change of what is deployed is a commit of the flow's file; the reconcile of that commit deploys it.
 * `toCommit` may refuse: what the catch-up applied before (a draft merged or marked) is kept, nothing is committed.
 */
export async function commitDeploy(
    ctx: UseCaseContext,
    flow: Flow,
    message: string,
    toCommit: (db: Database) => Promise<FlowToCommit | UseCaseError>,
): Promise<UseCaseResult<CommittedDeployments>> {
    let refused: UseCaseError | null = null;
    const commit = await commitFlows(ctx, message, async db => {
        await lockFlowDeployments(db, flow.id);
        const to = await toCommit(db);
        if ('code' in to) {
            refused = to;
            return new Map();
        }
        return new Map([[flow.id, to]]);
    });
    if (refused) {
        return { ok: false, error: refused };
    }

    return success({ ...(await loadDeployments(ctx.db, ctx.workspaceId, flow.id)), ...(commit ? { commit } : {}) });
}
