import { z } from 'zod';
import { activeFlow } from '#features/deployments/deployments';
import { replaceDraft } from '#features/git/draft-merge';
import { isGitOn } from '#features/git/git-config';
import { flowsInRepo } from '#features/git/workspace-export';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { CloneFlowHandler } from '../clone-flow/clone-flow-handler';
import { readDraft } from '../flow-draft';

export const DiscardDraftCommand = z.object({ id: z.uuid('Invalid'), copyAs: z.string().optional() });

/**
 * With git on, the draft takes git's content (the way out of a conflict); `copyAs` first keeps the draft as a new flow
 * under that name, a draft only.
 */
export class DiscardDraftHandler implements UseCaseHandler<{ revision: number; copy?: { id: string } }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ revision: number; copy?: { id: string } }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(DiscardDraftCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const row = await activeFlow(ctx, parsed.value.id);
        if (!row) {
            return fail('not-found', 'Flow not found.');
        }
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return fail('conflict', 'Git is off in this workspace.');
        }

        const [inRepo] = await flowsInRepo(ctx.db, ctx.workspaceId, [row.id]);
        if (!inRepo) {
            return fail('conflict', 'The flow has no file in git: there is nothing to take.');
        }

        return ctx.db.transaction(async db => {
            const tx = { ...ctx, db };
            let copy: { id: string } | undefined;
            if (parsed.value.copyAs !== undefined) {
                const cloned = await new CloneFlowHandler().handle({ id: row.id, name: parsed.value.copyAs }, tx);
                if (!cloned.ok) {
                    return cloned;
                }
                copy = cloned.value;
            }

            const revision = readDraft(row).revision + 1;
            await replaceDraft(db, row.id, { revision, flow: inRepo.definition }, row.name, inRepo.content_hash);
            return success({ revision, ...(copy ? { copy } : {}) });
        });
    }
}
