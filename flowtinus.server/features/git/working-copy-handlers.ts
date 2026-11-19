import { z } from 'zod';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { branchAccess } from './current-branch';
import { isGitOn } from './git-config';
import { commitWorkingCopy, createBranch, discardWorkingCopy, workingChanges, type CreatedBranch, type WorkingChange } from './working-copy-changes';

const gitOff = () => fail('conflict', 'Git is off in this workspace.');

export class GetChangesHandler implements UseCaseHandler<{ changes: WorkingChange[] }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ changes: WorkingChange[] }>> {
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return gitOff();
        }
        // a removed branch's changes are listed to whoever may take them to a new branch or discard them
        const { mayChange } = await branchAccess(ctx.db, ctx.workspaceId, ctx.userId);
        return success({ changes: mayChange ? await workingChanges(ctx) : [] });
    }
}

export const CommitChangesCommand = z.object({
    paths: z.array(z.string().min(1)).min(1),
    message: z.string().trim().min(1).max(1000),
});

export class CommitChangesHandler implements UseCaseHandler<{ commit: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ commit: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(CommitChangesCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        const committed = await commitWorkingCopy(ctx, parsed.value);
        return committed.ok ? success({ commit: committed.value }) : committed;
    }
}

export const CreateBranchCommand = z.object({ name: z.string().trim().min(1, 'Required') });

export class CreateBranchHandler implements UseCaseHandler<CreatedBranch> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<CreatedBranch>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(CreateBranchCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        return createBranch(ctx, parsed.value.name);
    }
}

export const DiscardChangesCommand = z.union([z.object({ paths: z.array(z.string().min(1)).min(1) }), z.object({ mine: z.literal(true) })]);

export class DiscardChangesHandler implements UseCaseHandler<{ discarded: string[] }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ discarded: string[] }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(DiscardChangesCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return gitOff();
        }
        return discardWorkingCopy(ctx, 'paths' in parsed.value ? { paths: parsed.value.paths } : 'mine');
    }
}
