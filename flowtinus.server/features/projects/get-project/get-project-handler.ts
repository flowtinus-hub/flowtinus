import { branchArchive, branchProject, workBranch } from '#features/git/branch-read';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { projects } from '../project';
import { toProjectView, type ProjectView } from '../project-fields';
import { ProjectRepository } from '../project-repository';

export const GetProjectQuery = z.object({ id: z.uuid('Invalid') });

export class GetProjectHandler implements UseCaseHandler<ProjectView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ProjectView>> {
        const parsed = validate(GetProjectQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id } = parsed.value;
        const branch = await workBranch(ctx);
        if (branch) {
            const found = branchProject(branch, id) ?? (await branchArchive(ctx, branch)).projects.find(p => p.id === id);
            return found
                ? success({ ...toProjectView(found), ...(branch.editable ? {} : { readOnly: true as const }) })
                : fail('not-found', 'Project not found.');
        }
        const repository = new ProjectRepository(ctx.db, ctx.workspaceId);
        const project = (await repository.findById(id)) ?? (await repository.findDeleted(eq(projects.id, id), { limit: 1 }))[0];
        return project ? success(toProjectView(project)) : fail('not-found', 'Project not found.');
    }
}
