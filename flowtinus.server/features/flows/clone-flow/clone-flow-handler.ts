import { z } from 'zod';
import { isFolderVisible, repoFlowToYaml } from '@flowtinus/core';
import { changeTree } from '#features/git/git-first';
import { writeFile } from '#features/git/working-copy';
import { FlowRepository, loadTree, nameInTree, requireActiveProject } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { flowRepoPath, loadDraft } from '../flow-draft';

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
        const { flow } = await loadDraft(ctx.db, ctx.workspaceId, source);
        await changeTree(ctx, async db => {
            const copy = await new FlowRepository(db, ctx.workspaceId).insert({
                id,
                projectId: source.projectId,
                folderId,
                name,
                workerTag: source.workerTag,
                updatedBy: ctx.userId,
            });
            const content = repoFlowToYaml({ ...flow, id, name });
            await writeFile(db, ctx.workspaceId, {
                path: await flowRepoPath(db, ctx.workspaceId, copy),
                content,
                fileId: id,
                userId: ctx.userId,
                revision: 0,
            });
        });
        return success({ id });
    }
}
