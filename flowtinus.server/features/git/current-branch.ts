import { z } from 'zod';
import type { Database } from '#shared/database/database';
import { requireRole } from '#shared/use-cases/require-role';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { gitBranch } from './git-config';
import { readHeads } from './git-heads';
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

/**
 * A branch's kind, told by its name and the topology with nothing stored: an environment's (in the topology), the
 * app's own (never offered as a work branch), a user's (`users/<handle>/…`, its owner by the handle), or shared.
 */
export type BranchKind = 'environment' | 'app' | 'user' | 'shared';

export function branchKind(name: string, environments: string[]): { kind: BranchKind; owner?: string } {
    if (environments.includes(name)) {
        return { kind: 'environment' };
    }
    if (/^(promote|backport|hotfix|flowtinus)\//.test(name)) {
        return { kind: 'app' };
    }
    const user = /^users\/([^/]+)\/./.exec(name);
    return user ? { kind: 'user', owner: user[1]! } : { kind: 'shared' };
}

/** who is asking: their handle, and the branches the topology gives an environment */
export type Editor = { handle: string | null; environments: string[] };

/**
 * where this user may change the working copy: the environment's branch, a shared work branch, and their own
 * `users/<handle>/…` branch; nobody else's, admins included, and neither another environment's branch nor the app's own
 */
export function canEditBranch(branch: string | null, environment: string | null, editor: Editor): boolean {
    if (branch === null || branch === environment) {
        return true;
    }
    const { kind, owner } = branchKind(branch, environment ? [...editor.environments, environment] : editor.environments);
    return kind === 'shared' || (kind === 'user' && owner === editor.handle);
}

export async function editorOf(db: Database, workspaceId: string, userId: string): Promise<Editor> {
    const [[me], heads] = await Promise.all([
        db.query<{ handle: string }>('SELECT handle FROM users WHERE id::text = $1', [userId]),
        readHeads(db, workspaceId),
    ]);
    return { handle: me?.handle ?? null, environments: heads?.environments ?? [] };
}

/** editable: whether the editor may change things on it (else it is read only) */
export type CurrentBranchView = { branch: string | null; editable: boolean };

export async function currentBranchView(db: Database, workspaceId: string, userId: string): Promise<CurrentBranchView> {
    const [git, branch, editor] = await Promise.all([
        gitBranch(db, workspaceId),
        currentBranch(db, workspaceId, userId),
        editorOf(db, workspaceId, userId),
    ]);
    return { branch, editable: canEditBranch(branch, git?.branch ?? null, editor) };
}

export function readOnlyBranch(branch: string, environments: string[]): string {
    const { kind, owner } = branchKind(branch, environments);
    return kind === 'user'
        ? `The branch ${branch} is ${owner}'s: only its owner changes it. Create a branch from it to make changes.`
        : `You are on the branch ${branch}, which is read only here: pick the environment's branch to make changes.`;
}

/**
 * Refused unless the user is on the environment's branch, for a change made to the tables (they are the environment's
 * branch): on a work branch it would land where they are not looking.
 */
export async function refuseOffEditableBranch(db: Database, workspaceId: string, userId: string | null): Promise<void> {
    if (userId === null) {
        return;
    }
    const [git, branch, editor] = await Promise.all([
        gitBranch(db, workspaceId),
        currentBranch(db, workspaceId, userId),
        editorOf(db, workspaceId, userId),
    ]);
    if (branch === null || branch === git?.branch) {
        return;
    }
    if (!canEditBranch(branch, git?.branch ?? null, editor)) {
        throw new UseCaseFailure('conflict', readOnlyBranch(branch, editor.environments));
    }
    throw new UseCaseFailure('conflict', `This change cannot be made on a work branch yet: make it on ${git?.branch}.`);
}

export class GetCurrentBranchHandler implements UseCaseHandler<CurrentBranchView> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<CurrentBranchView>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }

        return success(await currentBranchView(ctx.db, ctx.workspaceId, ctx.userId));
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
        return success({ branch, editable: canEditBranch(branch, git.branch, await editorOf(ctx.db, ctx.workspaceId, ctx.userId)) });
    }
}
