import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { subtreeIds } from '@flowtinus/core';
import { undeployArchived } from '#features/deployments/deployments';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { folders } from '../folder';
import { FlowRepository, FolderRepository, loadTree, requireActiveProject } from '../project-tree';

export const DeleteFolderCommand = z.object({ id: z.uuid('Invalid') });

export class DeleteFolderHandler implements UseCaseHandler<{ id: string; flows: number }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string; flows: number }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(DeleteFolderCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id } = parsed.value;
        const [folder] = await new FolderRepository(ctx.db, ctx.workspaceId).findAll(eq(folders.id, id));
        if (!folder) {
            return fail('not-found', 'Folder not found.');
        }

        if (!folder.deletedAt) {
            return fail('conflict', 'Only an archived folder can be deleted: archive it first.');
        }

        if (await requireActiveProject(ctx, folder.projectId)) {
            return fail('not-found', 'Project not found.');
        }

        const tree = await loadTree(ctx.db, ctx.workspaceId, folder.projectId);
        const subtree = subtreeIds(tree.folders, id);
        // under an archived folder everything is archived (nothing is restored or moved into it); one that is not stays
        const folderIds = tree.folders.filter(f => subtree.has(f.id) && f.archivedAt !== null).map(f => f.id);
        const flowIds = tree.flows.filter(f => f.folderId !== null && subtree.has(f.folderId) && f.archivedAt !== null).map(f => f.id);
        await ctx.db.transaction(async tx => {
            await new FolderRepository(tx, ctx.workspaceId).removeArchived(folderIds, ctx.userId);
            await new FlowRepository(tx, ctx.workspaceId).removeArchived(flowIds, ctx.userId);
            await undeployArchived(tx, ctx, flowIds);
        });
        return success({ id, flows: flowIds.length });
    }
}
