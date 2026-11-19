import { z } from 'zod';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import type { FlowFile } from '@flowtinus/core';
import { changeTree } from '#features/git/git-first';
import { isGitOn } from '#features/git/git-config';
import { commitDeploy, type CommittedDeployments } from '../commit-deploy';
import { activeFlow, currentDeployment, loadDeployments, lockFlowDeployments, setDeployed } from '../deployments';

export const UndeployFlowCommand = z.object({ id: z.uuid('Invalid') });

export class UndeployFlowHandler implements UseCaseHandler<CommittedDeployments> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<CommittedDeployments>> {
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

        if (await isGitOn(ctx.db, ctx.workspaceId)) {
            return commitDeploy(ctx, row, `Undeploy ${row.name}`, async db => {
                const current = await currentDeployment(db, ctx.workspaceId, row.id);
                if (!current) {
                    return { code: 'validation', message: 'The flow is not deployed.' };
                }
                const [version] = await db.query<{ definition: FlowFile }>('SELECT definition FROM flow_versions WHERE id = $1', [
                    current.id,
                ]);
                return { definition: version!.definition, deployed: false };
            });
        }

        const undeployed = await changeTree(ctx, async tx => {
            await lockFlowDeployments(tx, row.id);
            const current = await currentDeployment(tx, ctx.workspaceId, row.id);
            if (!current) {
                return false;
            }

            await setDeployed(tx, ctx, row.id, 'undeploy', current.id, null);
            return true;
        });
        if (!undeployed) {
            return fail('validation', 'The flow is not deployed.');
        }

        return success(await loadDeployments(ctx.db, ctx.workspaceId, row.id));
    }
}
