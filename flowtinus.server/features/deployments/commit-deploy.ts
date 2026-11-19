import { repoFlowToYaml, type FlowFile } from '@flowtinus/core';
import type { Flow } from '#features/flows/flow';
import { flowRepoPath } from '#features/flows/flow-draft';
import { commitTree } from '#features/git/git-first';
import { idOfFile } from '#features/git/working-copy';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { success, type UseCaseError, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { loadDeployments, lockFlowDeployments, type FlowDeploymentsView } from './deployments';

export type CommittedDeployments = FlowDeploymentsView & { commit?: string };

export type FlowToCommit = { definition: FlowFile; deployed: boolean };

/**
 * With git on, an undeploy or a version deployed is a commit of the flow's file as git has it, whatever the working
 * copy holds (the reconcile of that commit deploys it, and merges it into the flow's draft).
 */
export async function commitDeploy(
    ctx: UseCaseContext,
    flow: Flow,
    message: string,
    toCommit: (db: Database) => Promise<FlowToCommit | UseCaseError>,
): Promise<UseCaseResult<CommittedDeployments>> {
    const committed = await commitTree(ctx, message, async (db, tip) => {
        await lockFlowDeployments(db, flow.id);
        const to = await toCommit(db);
        if ('code' in to) {
            return to;
        }
        const path = Object.keys(tip).find(p => idOfFile(p, tip[p]!) === flow.id) ?? (await flowRepoPath(db, ctx.workspaceId, flow));
        return { changes: { [path]: repoFlowToYaml({ ...to.definition, id: flow.id }, { deployed: to.deployed }) } };
    });
    if (!committed.ok) {
        return committed;
    }

    return success({
        ...(await loadDeployments(ctx.db, ctx.workspaceId, flow.id)),
        ...(committed.value ? { commit: committed.value } : {}),
    });
}
