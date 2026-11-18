import type { Flow } from '#features/flows/flow';
import { commitTree } from '#features/git/git-first';
import type { FlowToCommit } from '#features/git/workspace-export';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { success, type UseCaseError, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { loadDeployments, lockFlowDeployments, type FlowDeploymentsView } from './deployments';

export type CommittedDeployments = FlowDeploymentsView & { commit?: string };

/**
 * With git on, a change of what is deployed is a commit of the flow's file (and of the scripts `toCommit` adds); the
 * reconcile of that commit deploys it.
 */
export async function commitDeploy(
    ctx: UseCaseContext,
    flow: Flow,
    message: string,
    toCommit: (db: Database) => Promise<(FlowToCommit & { scripts?: Map<string, string> }) | UseCaseError>,
): Promise<UseCaseResult<CommittedDeployments>> {
    const committed = await commitTree(ctx, message, async db => {
        await lockFlowDeployments(db, flow.id);
        const to = await toCommit(db);
        if ('code' in to) {
            return to;
        }
        const { scripts, ...file } = to;
        return { flows: new Map([[flow.id, file]]), ...(scripts ? { scripts } : {}) };
    });
    if (!committed.ok) {
        return committed;
    }

    return success({
        ...(await loadDeployments(ctx.db, ctx.workspaceId, flow.id)),
        ...(committed.value ? { commit: committed.value } : {}),
    });
}
