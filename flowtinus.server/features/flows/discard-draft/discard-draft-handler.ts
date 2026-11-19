import { z } from 'zod';
import { activeFlow } from '#features/deployments/deployments';
import { isGitOn } from '#features/git/git-config';
import { fileRow } from '#features/git/working-copy';
import { discardWorkingCopy } from '#features/git/working-copy-changes';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { CloneFlowHandler } from '../clone-flow/clone-flow-handler';

export const DiscardDraftCommand = z.object({ id: z.uuid('Invalid'), copyAs: z.string().optional() });

/**
 * With git on, the flow's file in the working copy goes back as committed (the way out of a conflict); `copyAs` first
 * keeps the draft as a new flow under that name, a change of the working copy of its own.
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

        const draft = await fileRow(ctx.db, ctx.workspaceId, row.id);
        if (!draft?.base) {
            return draft ? fail('conflict', 'The flow has no file in git: there is nothing to take.') : success({ revision: 0 });
        }

        let copy: { id: string } | undefined;
        if (parsed.value.copyAs !== undefined) {
            const cloned = await new CloneFlowHandler().handle({ id: row.id, name: parsed.value.copyAs }, ctx);
            if (!cloned.ok) {
                return cloned;
            }
            copy = cloned.value;
        }

        const discarded = await discardWorkingCopy(ctx, { paths: [draft.path] });
        if (!discarded.ok && discarded.error.code !== 'not-found') {
            return discarded;
        }
        const revision = (await fileRow(ctx.db, ctx.workspaceId, row.id))?.revision ?? 0;
        return success({ revision, ...(copy ? { copy } : {}) });
    }
}
