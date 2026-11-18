import { z } from 'zod';
import type { Database } from '#shared/database/database';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { gitBranch } from './git-config';
import { CONFIG_BRANCH } from './topology';

/** git's own rule (git check-ref-format --branch): any branch of the remote, those pushed from a laptop included */
export function gitBranchNameError(branch: string): string | null {
    if (
        branch.length === 0 ||
        branch.length > 255 ||
        /[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^[-/]|[/.]$|(^|\/)\.|\.lock(\/|$)/.test(branch) ||
        branch === '@' ||
        branch === 'HEAD'
    ) {
        return 'Not a valid branch name';
    }

    return branch === CONFIG_BRANCH ? `${CONFIG_BRANCH} holds the topology` : null;
}

/** with git on, the user's current branch in the workspace (the environment's branch until another is picked); null with git off */
export async function currentBranch(db: Database, workspaceId: string, userId: string): Promise<string | null> {
    const git = await gitBranch(db, workspaceId);
    if (!git) {
        return null;
    }

    const [row] = await db.query<{ branch: string }>('SELECT branch FROM user_branches WHERE workspace_id = $1 AND user_id::text = $2', [
        workspaceId,
        userId,
    ]);
    return row?.branch ?? git.branch;
}

export type CurrentBranchView = { branch: string | null };

export class GetCurrentBranchHandler implements UseCaseHandler<CurrentBranchView> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<CurrentBranchView>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }

        return success({ branch: await currentBranch(ctx.db, ctx.workspaceId, ctx.userId) });
    }
}

const SetCurrentBranchInput = z.object({
    branch: z.string('Required').superRefine((value, issue) => {
        const error = gitBranchNameError(value);
        if (error) {
            issue.addIssue({ code: 'custom', message: error });
        }
    }),
});

export class SetCurrentBranchHandler implements UseCaseHandler<CurrentBranchView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<CurrentBranchView>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }
        const parsed = validate(SetCurrentBranchInput, input);
        if (!parsed.ok) {
            return parsed;
        }
        const git = await gitBranch(ctx.db, ctx.workspaceId);
        if (!git) {
            return fail('conflict', 'Git is off in this workspace: there are no branches to pick.');
        }

        const { branch } = parsed.value;
        // the environment's branch is kept as no row, so the user follows it when the topology moves it
        if (branch === git.branch) {
            await ctx.db.query('DELETE FROM user_branches WHERE workspace_id = $1 AND user_id::text = $2', [ctx.workspaceId, ctx.userId]);
        } else {
            await ctx.db.query(
                `INSERT INTO user_branches (workspace_id, user_id, branch) VALUES ($1, $2, $3)
                 ON CONFLICT (workspace_id, user_id) DO UPDATE SET branch = EXCLUDED.branch, updated_at = now()`,
                [ctx.workspaceId, ctx.userId, branch],
            );
        }
        return success({ branch });
    }
}
