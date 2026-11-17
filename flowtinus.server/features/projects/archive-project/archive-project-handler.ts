import { z } from 'zod';
import { mirrorGitChange } from '#features/git/git-mirror';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { undeployArchived } from '#features/deployments/deployments';
import { FlowRepository, FolderRepository, loadTree } from '#features/folders/project-tree';
import { ProjectRepository } from '../project-repository';

export const ArchiveProjectCommand = z.object({ id: z.uuid('Invalid') });

export class ArchiveProjectHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(ArchiveProjectCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id } = parsed.value;
        const archive = { deletedAt: new Date(), deletedBy: ctx.userId };
        const name = (await new ProjectRepository(ctx.db, ctx.workspaceId).findById(id))?.name ?? '';
        const archived = await mirrorGitChange(ctx, `Archive project ${name}`, async tx => {
            if (!(await new ProjectRepository(tx, ctx.workspaceId).update(id, archive))) {
                return false;
            }

            const tree = await loadTree(tx, ctx.workspaceId, id);
            const folderRepository = new FolderRepository(tx, ctx.workspaceId);
            const flowRepository = new FlowRepository(tx, ctx.workspaceId);
            for (const folder of tree.folders.filter(f => f.archivedAt === null)) {
                await folderRepository.update(folder.id, archive);
            }

            for (const flow of tree.flows.filter(f => f.archivedAt === null)) {
                await flowRepository.update(flow.id, archive);
            }

            await undeployArchived(
                tx,
                ctx,
                tree.flows.map(f => f.id),
            );
            return true;
        });
        if (!archived) {
            return fail('not-found', 'Project not found.');
        }

        return success({ id });
    }
}
