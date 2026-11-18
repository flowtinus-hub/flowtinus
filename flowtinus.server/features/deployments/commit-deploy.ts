import type { Flow } from '#features/flows/flow';
import { commitFlows } from '#features/git/git-first';
import type { FlowToCommit } from '#features/git/workspace-export';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { loadDeployments, lockFlowDeployments, type FlowDeploymentsView } from './deployments';

export type CommittedDeployments = FlowDeploymentsView & { commit?: string };

/** with git on, a change of what is deployed is a commit of the flow's file; the reconcile of that commit deploys it */
export async function commitDeploy(
    ctx: UseCaseContext,
    flow: Flow,
    message: string,
    toCommit: (db: Database) => Promise<FlowToCommit>,
): Promise<UseCaseResult<CommittedDeployments>> {
    const commit = await commitFlows(ctx, message, async db => {
        await lockFlowDeployments(db, flow.id);
        return new Map([[flow.id, await toCommit(db)]]);
    });
    return success({ ...(await loadDeployments(ctx.db, ctx.workspaceId, flow.id)), ...(commit ? { commit } : {}) });
}
