import { z } from 'zod';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import type { FlowFile } from '@flowtinus/core';
import { changeTree } from '#features/git/git-first';
import { isGitOn } from '#features/git/git-config';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import { commitDeploy, type CommittedDeployments } from '../commit-deploy';
import { activeFlow, currentDeployment, loadDeployments, lockFlowDeployments, setDeployed } from '../deployments';

export const DeployVersionCommand = z.object({ id: z.uuid('Invalid'), versionId: z.uuid('Invalid') });

/**
 * Makes one of the flow's versions the deployed one: older than the deployed is a rollback; a newer one (after a
 * rollback), or any one while nothing is deployed, is a deploy. The versions never change.
 */
export class DeployVersionHandler implements UseCaseHandler<CommittedDeployments> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<CommittedDeployments>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(DeployVersionCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const row = await activeFlow(ctx, parsed.value.id);
        if (!row) {
            return fail('not-found', 'Flow not found.');
        }

        const [version] = await ctx.db.query<{ id: string; number: number; definition: FlowFile }>(
            'SELECT id, number, definition FROM flow_versions WHERE workspace_id = $1 AND flow_id = $2 AND id = $3',
            [ctx.workspaceId, row.id, parsed.value.versionId],
        );
        if (!version) {
            return fail('not-found', 'Version not found.');
        }

        if (await isGitOn(ctx.db, ctx.workspaceId)) {
            const [newest] = await ctx.db.query<{ number: number }>('SELECT max(number) AS number FROM flow_versions WHERE flow_id = $1', [
                row.id,
            ]);
            const message =
                version.number < newest!.number ? `Revert ${row.name} to v${version.number}` : `Deploy ${row.name} v${version.number}`;
            return commitDeploy(ctx, row, message, async db => {
                if ((await currentDeployment(db, ctx.workspaceId, row.id))?.id === version.id) {
                    throw new UseCaseFailure('validation', `v${version.number} is already deployed.`);
                }
                return { definition: version.definition, deployed: true };
            });
        }

        const action = await changeTree(
            ctx,
            done => (done === 'rollback' ? `Roll back ${row.name} to v${version.number}` : `Deploy ${row.name} v${version.number}`),
            async tx => {
                await lockFlowDeployments(tx, row.id);
                const current = await currentDeployment(tx, ctx.workspaceId, row.id);
                if (current?.id === version.id) {
                    return null;
                }

                const action = current && version.number < current.number ? 'rollback' : 'deploy';
                await setDeployed(tx, ctx, row.id, action, current?.id ?? null, version.id);
                return action;
            },
        );
        if (!action) {
            return fail('validation', `v${version.number} is already deployed.`);
        }

        return success(await loadDeployments(ctx.db, ctx.workspaceId, row.id));
    }
}
