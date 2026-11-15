import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { FlowRepository, FolderRepository, loadTree } from '#features/folders/project-tree';
import { projects } from '../project';
import { toProjectView, type ProjectView } from '../project-fields';
import { ProjectRepository } from '../project-repository';

export const RestoreProjectCommand = z.object({ id: z.uuid('Invalid') });

/**
 * Brings an archived project back with the folders and flows archived with it (same time); those archived on their own
 * before stay archived. Its flows are not deployed again. Refused when an active project took its name meanwhile.
 */
export class RestoreProjectHandler implements UseCaseHandler<ProjectView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ProjectView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(RestoreProjectCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id } = parsed.value;
        const repository = new ProjectRepository(ctx.db, ctx.workspaceId);
        const [archived] = await repository.findDeleted(eq(projects.id, id), { limit: 1 });
        if (!archived?.deletedAt) {
            return fail('not-found', 'Archived project not found.');
        }

        if (await repository.existsByName(archived.name)) {
            return fail('conflict', `An active project is already named "${archived.name}". Rename it first.`, { name: 'Already in use' });
        }

        const archivedAt = archived.deletedAt.getTime();
        const together = (item: { deletedAt: Date | null }) => item.deletedAt?.getTime() === archivedAt;
        const restored = await ctx.db.transaction(async tx => {
            const tree = await loadTree(tx, ctx.workspaceId, id);
            const folderRepository = new FolderRepository(tx, ctx.workspaceId);
            const flowRepository = new FlowRepository(tx, ctx.workspaceId);
            for (const folder of tree.folders.filter(together)) {
                await folderRepository.restore(folder.id);
            }

            for (const flow of tree.flows.filter(together)) {
                await flowRepository.restore(flow.id);
            }

            return new ProjectRepository(tx, ctx.workspaceId).restore(id);
        });
        return restored ? success(toProjectView(restored)) : fail('not-found', 'Archived project not found.');
    }
}
