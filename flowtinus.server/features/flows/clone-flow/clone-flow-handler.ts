import { z } from 'zod';
import { isFolderVisible } from '@flowtinus/core';
import { FlowRepository, loadTree, nameInTree, requireActiveProject } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { readDraft, type StoredDraft } from '../flow-draft';

export const CloneFlowCommand = z.object({
    id: z.uuid('Invalid'),
    name: z.string(),
    folderId: z.uuid('Invalid').nullable().optional(),
});

export class CloneFlowHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(CloneFlowCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const repository = new FlowRepository(ctx.db, ctx.workspaceId);
        const source = await repository.findById(parsed.value.id);
        const tree = source ? await loadTree(ctx.db, ctx.workspaceId, source.projectId) : null;
        if (!source || !tree || !isFolderVisible(tree.folders, source.folderId)) {
            return fail('not-found', 'Flow not found.');
        }

        const missing = await requireActiveProject(ctx, source.projectId);
        if (missing) {
            return missing;
        }

        const folderId = parsed.value.folderId === undefined ? source.folderId : parsed.value.folderId;
        if (!isFolderVisible(tree.folders, folderId)) {
            return fail('not-found', 'Folder not found.');
        }

        const id = crypto.randomUUID();
        const named = await nameInTree(ctx, source.projectId, tree, { kind: 'flow', id, parentId: folderId, name: parsed.value.name });
        if (!named.ok) {
            return named;
        }

        const name = named.value;
        const draft: StoredDraft = { revision: 0, flow: { ...readDraft(source).flow, id, name } };
        await repository.insert({
            id,
            projectId: source.projectId,
            folderId,
            name,
            draftDefinition: draft,
            workerTag: source.workerTag,
            updatedBy: ctx.userId,
        });
        return success({ id });
    }
}
