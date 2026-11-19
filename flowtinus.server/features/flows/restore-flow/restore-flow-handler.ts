import { z } from 'zod';
import { changeTree } from '#features/git/git-first';
import { eq } from 'drizzle-orm';
import { isFolderVisible } from '@flowtinus/core';
import { FlowRepository, loadTree, nameInTree, projectArchived, toFlowView, type FlowView } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { flows } from '../flow';

export const RestoreFlowCommand = z.object({ id: z.uuid('Invalid') });

/**
 * Brings an archived flow back into its folder; to the project's root when that folder is archived or gone. Refused
 * while its project is archived (restoring the project brings back what went with it).
 */
export class RestoreFlowHandler implements UseCaseHandler<FlowView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(RestoreFlowCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id } = parsed.value;
        const repository = new FlowRepository(ctx.db, ctx.workspaceId);
        const [flow] = await repository.findDeleted(eq(flows.id, id));
        if (!flow) {
            return fail('not-found', 'Archived flow not found.');
        }

        const inArchivedProject = await projectArchived(ctx, flow.projectId);
        if (inArchivedProject) {
            return inArchivedProject;
        }

        const tree = await loadTree(ctx.db, ctx.workspaceId, flow.projectId);
        const folderId = isFolderVisible(tree.folders, flow.folderId) ? flow.folderId : null;
        const named = await nameInTree(ctx, flow.projectId, tree, { kind: 'flow', id, parentId: folderId, name: flow.name });
        if (!named.ok) {
            return named;
        }

        const restored = await changeTree(ctx, async tx => {
            const inTx = new FlowRepository(tx, ctx.workspaceId);
            await inTx.restore(id);
            return inTx.update(id, { folderId, deletedByCommit: null });
        });

        return restored ? success(toFlowView(restored)) : fail('not-found', 'Archived flow not found.');
    }
}
