import { refuseOffEditableBranch } from '#features/git/current-branch';
import { z } from 'zod';
import { isFolderVisible, validateFlowFile } from '@flowtinus/core';
import { FlowRepository, loadTree } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { writeDraft } from '../flow-draft';

export const SaveDraftCommand = z.object({
    id: z.uuid('Invalid'),
    revision: z.number().int().min(0),
    flow: z.unknown(),
});

export class SaveDraftHandler implements UseCaseHandler<{ revision: number }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ revision: number }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        await refuseOffEditableBranch(ctx.db, ctx.workspaceId, ctx.userId);
        const parsed = validate(SaveDraftCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id, revision } = parsed.value;
        const row = await new FlowRepository(ctx.db, ctx.workspaceId).findById(id);
        const tree = row ? await loadTree(ctx.db, ctx.workspaceId, row.projectId) : null;
        if (!row || !tree || !isFolderVisible(tree.folders, row.folderId)) {
            return fail('not-found', 'Flow not found.');
        }

        const checked = validateFlowFile(parsed.value.flow);
        if (!checked.ok) {
            return fail('validation', `The flow is not valid: ${checked.errors.join(' ')}`);
        }

        const saved = await ctx.db.transaction(db =>
            writeDraft(db, ctx.workspaceId, row, { ...checked.value, id: row.id, name: row.name }, ctx.userId, revision),
        );
        return saved === null ? conflict() : success({ revision: saved });
    }
}

const conflict = () => fail('conflict', 'This flow was changed elsewhere. Reload it to see the latest version.');
