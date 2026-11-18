import { z } from 'zod';
import { changeTree } from '#features/git/git-first';
import { isFolderVisible, subtreeIds } from '@flowtinus/core';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { undeployArchived } from '#features/deployments/deployments';
import { FlowRepository, FolderRepository, loadTree } from '../project-tree';

export const ArchiveFolderCommand = z.object({ id: z.uuid('Invalid') });

/**
 * Archives an active folder and every active folder and flow under it, all with the same time (in one transaction),
 * so restoring the folder knows what went with it. What was archived before stays as it was. The deployed flows among
 * them are undeployed.
 */
export class ArchiveFolderHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(ArchiveFolderCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id } = parsed.value;
        const folder = await new FolderRepository(ctx.db, ctx.workspaceId).findById(id);
        const tree = folder ? await loadTree(ctx.db, ctx.workspaceId, folder.projectId) : null;
        if (!folder || !tree || !isFolderVisible(tree.folders, id)) {
            return fail('not-found', 'Folder not found.');
        }

        const subtree = subtreeIds(tree.folders, id);
        const archive = { deletedAt: new Date(), deletedBy: ctx.userId };
        await changeTree(
            ctx,
            () => `Archive folder ${folder.name}`,
            async tx => {
                const folderRepository = new FolderRepository(tx, ctx.workspaceId);
                const flowRepository = new FlowRepository(tx, ctx.workspaceId);
                for (const item of tree.folders.filter(f => subtree.has(f.id) && f.archivedAt === null)) {
                    await folderRepository.update(item.id, archive);
                }

                const flows = tree.flows.filter(f => f.folderId !== null && subtree.has(f.folderId) && f.archivedAt === null);
                for (const item of flows) {
                    await flowRepository.update(item.id, archive);
                }

                await undeployArchived(
                    tx,
                    ctx,
                    flows.map(f => f.id),
                );
            },
        );

        return success({ id });
    }
}
