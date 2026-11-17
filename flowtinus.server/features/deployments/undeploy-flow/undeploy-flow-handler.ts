import { z } from 'zod';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import type { GitOptions } from '#features/git/git-config';
import { pushPendingCommits } from '#features/git/git-commits';
import { activeFlow, currentDeployment, loadDeployments, lockFlowDeployments, queueFlowFile, setDeployed, type FlowDeploymentsView } from '../deployments';

export const UndeployFlowCommand = z.object({ id: z.uuid('Invalid') });

export class UndeployFlowHandler implements UseCaseHandler<FlowDeploymentsView> {
    constructor(private readonly git: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowDeploymentsView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(UndeployFlowCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const row = await activeFlow(ctx, parsed.value.id);
        if (!row) {
            return fail('not-found', 'Flow not found.');
        }

        const undeployed = await ctx.db.transaction(async tx => {
            await lockFlowDeployments(tx, row.id);
            const current = await currentDeployment(tx, ctx.workspaceId, row.id);
            if (!current) {
                return false;
            }

            await setDeployed(tx, ctx, row.id, 'undeploy', current.id, null);
            await queueFlowFile(tx, ctx, row, current.id, { message: `Undeploy ${row.name}`, deployed: false });
            return true;
        });
        if (!undeployed) {
            return fail('validation', 'The flow is not deployed.');
        }

        await pushPendingCommits(ctx, this.git);
        return success(await loadDeployments(ctx.db, ctx.workspaceId, row.id));
    }
}
