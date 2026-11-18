import { z } from 'zod';
import { validateFlowFile } from '@flowtinus/core';
import { readDraft } from '#features/flows/flow-draft';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { changeTree } from '#features/git/git-first';
import { isGitOn } from '#features/git/git-config';
import { draftToCommit } from '#features/git/draft-merge';
import { scriptsToCommit } from '#features/scripts/script-git';
import { commitDeploy, type CommittedDeployments } from '../commit-deploy';
import { activeFlow, contentHash, currentDeployment, insertVersion, loadDeployments, lockFlowDeployments, newestVersionLike, setDeployed } from '../deployments';

export const DeployFlowCommand = z.object({
    id: z.uuid('Invalid'),
    message: z.string().trim().min(1).max(1000).optional(),
    scripts: z.array(z.string()).optional(),
});

export class DeployFlowHandler implements UseCaseHandler<CommittedDeployments> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<CommittedDeployments>> {
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

        if (await isGitOn(ctx.db, ctx.workspaceId)) {
            return commitDeploy(ctx, row, parsed.value.message ?? `Update ${row.name}`, async db => {
                const draft = await draftToCommit(db, ctx.workspaceId, row.id);
                if ('code' in draft) {
                    return draft;
                }
                const scripts = await scriptsToCommit(db, ctx.workspaceId, row.projectId, parsed.value.scripts ?? []);
                if (!(scripts instanceof Map)) {
                    return scripts;
                }
                const current = await currentDeployment(db, ctx.workspaceId, row.id);
                if (current?.hash === contentHash(draft) && scripts.size === 0) {
                    return { code: 'validation', message: `Nothing to commit: the draft is v${current.number}.` };
                }
                return { definition: draft, deployed: true, scripts };
            });
        }

        const checked = validateFlowFile(readDraft(row).flow);
        if (!checked.ok) {
            return fail('validation', `The flow cannot be deployed: ${checked.errors.join(' ')}`);
        }

        const draft = checked.value;

        const deployed = await changeTree<{ deployed: boolean; number: number }>(
            ctx,
            done => `Deploy ${row.name} v${done.number}`,
            async tx => {
                await lockFlowDeployments(tx, row.id);
                const current = await currentDeployment(tx, ctx.workspaceId, row.id);
                if (current?.hash === contentHash(draft)) {
                    return { deployed: false, number: current.number };
                }

                const version =
                    (await newestVersionLike(tx, ctx.workspaceId, row.id, draft)) ?? (await insertVersion(tx, ctx, row.id, draft));
                await setDeployed(tx, ctx, row.id, 'deploy', current?.id ?? null, version.id);
                return { deployed: true, number: version.number };
            },
        );
        if (!deployed.deployed) {
            return fail('validation', `Nothing to deploy: the draft is v${deployed.number}.`);
        }

        return success(await loadDeployments(ctx.db, ctx.workspaceId, row.id));
    }
}
