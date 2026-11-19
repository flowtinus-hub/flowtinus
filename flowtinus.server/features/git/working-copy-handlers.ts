import { z } from 'zod';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { isGitOn } from './git-config';
import { commitWorkingCopy, discardWorkingCopy, workingChanges, type WorkingChange } from './working-copy-changes';

const gitOff = () => fail('conflict', 'Git is off in this workspace.');

export class GetChangesHandler implements UseCaseHandler<{ changes: WorkingChange[] }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ changes: WorkingChange[] }>> {
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return gitOff();
        }
        return success({ changes: await workingChanges(ctx) });
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
