import { workBranch } from '#features/git/branch-read';
import { updateProjectOnBranch } from '#features/git/branch-edits';
import { changeTree } from '#features/git/git-first';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { handleTaken, toProjectView } from '../project-fields';
import { pathTooLong } from '#features/folders/project-tree';
import type { Project } from '../project';
import { ProjectRepository } from '../project-repository';
import { UpdateProjectCommand, type UpdateProjectResponse } from './update-project-command';

export class UpdateProjectHandler implements UseCaseHandler<UpdateProjectResponse> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<UpdateProjectResponse>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(UpdateProjectCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const branch = await workBranch(ctx);
        if (branch) {
            return updateProjectOnBranch(ctx, branch, parsed.value);
        }
        const { id, ...changes } = parsed.value;
        const projects = new ProjectRepository(ctx.db, ctx.workspaceId);
        const holder = changes.name === undefined ? undefined : await projects.handleHolder(changes.name, id);
        if (holder) {
            return handleTaken(changes.name!, holder);
        }

        if (changes.name !== undefined) {
            const tooLong = await pathTooLong(ctx, id, { project: changes.name });
            if (tooLong) {
                return tooLong;
            }
        }

        const project = await changeTree<Project | null>(ctx, db => new ProjectRepository(db, ctx.workspaceId).update(id, changes));
        if (!project) {
            return fail('not-found', 'Project not found.');
        }

        return success(toProjectView(project));
    }
}
