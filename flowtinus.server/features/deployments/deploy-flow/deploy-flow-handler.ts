import { z } from 'zod';
import { validateFlowFile } from '@flowtinus/core';
import type { Flow } from '#features/flows/flow';
import { loadDraft } from '#features/flows/flow-draft';
import { fileRow } from '#features/git/working-copy';
import { commitWorkingCopy } from '#features/git/working-copy-changes';
import { workingScriptPaths } from '#features/scripts/script-git';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { changeTree } from '#features/git/git-first';
import { isGitOn } from '#features/git/git-config';
import type { CommittedDeployments } from '../commit-deploy';
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
            return commitFlow(ctx, row, parsed.value.message ?? `Update ${row.name}`, parsed.value.scripts ?? []);
        }

        const checked = validateFlowFile((await loadDraft(ctx.db, ctx.workspaceId, row)).flow);
        if (!checked.ok) {
            return fail('validation', `The flow cannot be deployed: ${checked.errors.join(' ')}`);
        }

        const draft = checked.value;

        const deployed = await changeTree<{ deployed: boolean; number: number }>(ctx, async tx => {
            await lockFlowDeployments(tx, row.id);
            const current = await currentDeployment(tx, ctx.workspaceId, row.id);
            if (current?.hash === contentHash(draft)) {
                return { deployed: false, number: current.number };
            }

            const version = (await newestVersionLike(tx, ctx.workspaceId, row.id, draft)) ?? (await insertVersion(tx, ctx, row.id, draft));
            await setDeployed(tx, ctx, row.id, 'deploy', current?.id ?? null, version.id);
            return { deployed: true, number: version.number };
        });
        if (!deployed.deployed) {
            return fail('validation', `Nothing to deploy: the draft is v${deployed.number}.`);
        }

        return success(await loadDeployments(ctx.db, ctx.workspaceId, row.id));
    }
}

/** the flow's Commit: its file, deployed, with the scripts named and what they all need */
async function commitFlow(
    ctx: UseCaseContext,
    row: Flow,
    message: string,
    scripts: string[],
): Promise<UseCaseResult<CommittedDeployments>> {
    const draft = await fileRow(ctx.db, ctx.workspaceId, row.id);
    if (draft?.conflict) {
        return fail(
            'conflict',
            `The draft conflicts with git's commit ${draft.conflict.slice(0, 7)}: discard it, or duplicate it as a new flow.`,
        );
    }
    const checked = validateFlowFile((await loadDraft(ctx.db, ctx.workspaceId, row)).flow);
    if (!checked.ok) {
        return fail('validation', `The flow cannot be deployed: ${checked.errors.join(' ')}`);
    }

    const scriptPaths = (await workingScriptPaths(ctx.db, ctx.workspaceId, row.projectId, scripts)) ?? [];
    const committed = await commitWorkingCopy(ctx, {
        paths: [...(draft ? [draft.path] : []), ...scriptPaths],
        message,
        deploy: { flowId: row.id },
    });
    if (!committed.ok) {
        const current = await currentDeployment(ctx.db, ctx.workspaceId, row.id);
        return committed.error.message === 'Nothing to commit.' && current
            ? fail('validation', `Nothing to commit: the draft is v${current.number}.`)
            : committed;
    }
    return success({ ...(await loadDeployments(ctx.db, ctx.workspaceId, row.id)), commit: committed.value });
}
