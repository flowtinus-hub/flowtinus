import { z } from 'zod';
import { validateFlowFile } from '@flowtinus/core';
import { readDraft } from '#features/flows/flow-draft';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import type { GitOptions } from '#features/git/git-config';
import { pushPendingCommits } from '#features/git/git-commits';
import { activeFlow, contentHash, currentDeployment, insertVersion, loadDeployments, lockFlowDeployments, newestVersionLike, queueFlowFile, setDeployed, type FlowDeploymentsView } from '../deployments';

export const DeployFlowCommand = z.object({ id: z.uuid('Invalid') });

export class DeployFlowHandler implements UseCaseHandler<FlowDeploymentsView> {
    constructor(private readonly git: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowDeploymentsView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(DeployFlowCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const row = await activeFlow(ctx, parsed.value.id);
        if (!row) {
            return fail('not-found', 'Flow not found.');
        }

        const checked = validateFlowFile(readDraft(row).flow);
        if (!checked.ok) {
            return fail('validation', `The flow cannot be deployed: ${checked.errors.join(' ')}`);
        }

        const draft = checked.value;
        const refused = await ctx.db.transaction(async tx => {
            await lockFlowDeployments(tx, row.id);
            const current = await currentDeployment(tx, ctx.workspaceId, row.id);
            if (current?.hash === contentHash(draft)) {
                return `Nothing to deploy: the draft is v${current.number}.`;
            }

            const version = (await newestVersionLike(tx, ctx.workspaceId, row.id, draft)) ?? (await insertVersion(tx, ctx, row.id, draft));
            await setDeployed(tx, ctx, row.id, 'deploy', current?.id ?? null, version.id);
            await queueFlowFile(tx, ctx, row, version.id, { message: `Deploy ${row.name} v${version.number}`, deployed: true });
            return null;
        });
        if (refused) {
            return fail('validation', refused);
        }

        await pushPendingCommits(ctx, this.git);
        return success(await loadDeployments(ctx.db, ctx.workspaceId, row.id));
    }
}
