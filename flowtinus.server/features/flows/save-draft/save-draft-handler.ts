import { workBranch } from '#features/git/branch-read';
import { saveDraftOnBranch } from '#features/git/branch-edits';
import { refuseOffEditableBranch } from '#features/git/current-branch';
import { z } from 'zod';
import { isFolderVisible, validateFlowFile } from '@flowtinus/core';
import { FlowRepository, loadTree } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { fileHash, REVISION, savesCounted, writeDraft, type Revision } from '../flow-draft';
import { saveDiskDraft } from '../disk-draft';
import { localRepoOf } from '#features/git/local-server';

export const SaveDraftCommand = z.object({
    id: z.uuid('Invalid'),
    revision: REVISION,
    flow: z.unknown(),
});

export class SaveDraftHandler implements UseCaseHandler<{ revision: Revision }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ revision: Revision }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(SaveDraftCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        const { id, revision } = parsed.value;
        const counted = savesCounted(revision);
        const branch = await workBranch(ctx);
        if (branch) {
            const checked = validateFlowFile(parsed.value.flow);
            if (!checked.ok) {
                return fail('validation', `The flow is not valid: ${checked.errors.join(' ')}`);
            }
            return counted === null ? conflict() : saveDraftOnBranch(ctx, branch, { id, revision: counted, flow: checked.value });
        }
        await refuseOffEditableBranch(ctx.db, ctx.workspaceId, ctx.userId);

        const row = await new FlowRepository(ctx.db, ctx.workspaceId).findById(id);
        const tree = row ? await loadTree(ctx.db, ctx.workspaceId, row.projectId) : null;
        if (!row || !tree || !isFolderVisible(tree.folders, row.folderId)) {
            return fail('not-found', 'Flow not found.');
        }

        const checked = validateFlowFile(parsed.value.flow);
        if (!checked.ok) {
            return fail('validation', `The flow is not valid: ${checked.errors.join(' ')}`);
        }

        const root = localRepoOf(ctx.git);
        if (root) {
            return saveDiskDraft(ctx, root, row, checked.value, fileHash(revision));
        }
        if (counted === null) {
            return conflict();
        }
        const saved = await ctx.db.transaction(db =>
            writeDraft(db, ctx.workspaceId, row, { ...checked.value, id: row.id, name: row.name }, ctx.userId, counted),
        );
        return saved === null ? conflict() : success({ revision: saved });
    }
}

const conflict = () => fail('conflict', 'This flow was changed elsewhere. Reload it to see the latest version.');
