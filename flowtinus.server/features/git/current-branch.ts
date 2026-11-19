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
import { CONFIG_BRANCH, type Mode } from './topology';

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

/** who is asking: their handle, the branches the topology gives an environment, and this environment's mode */
export type Editor = { handle: string | null; environments: string[]; mode: Mode };

/**
 * where this user may change the working copy: the environment's branch (not on a `pull-request` server, where the
 * first edit offers Create branch), a shared work branch, and their own `users/<handle>/…` branch; nobody else's, admins
 * included, and neither another environment's branch nor the app's own. A `protected` server is as step 2 left it:
 * drafts on its environment's branch (its tree's changes refused), every other branch read only.
 */
export function canEditBranch(branch: string | null, environment: string | null, editor: Editor): boolean {
    if (branch === null) {
        return true;
    }
    if (branch === environment) {
        return editor.mode !== 'pull-request';
    }
    if (editor.mode === 'protected') {
        return false;
    }
    const { kind, owner } = branchKind(branch, environment ? [...editor.environments, environment] : editor.environments);
    return kind === 'shared' || (kind === 'user' && owner === editor.handle);
}

export async function editorOf(db: Database, workspaceId: string, userId: string): Promise<Editor> {
    const [[me], heads, git] = await Promise.all([
        db.query<{ handle: string }>('SELECT handle FROM users WHERE id::text = $1', [userId]),
        readHeads(db, workspaceId),
        gitBranch(db, workspaceId),
    ]);
    return { handle: me?.handle ?? null, environments: heads?.environments ?? [], mode: git?.mode ?? 'direct' };
}

/**
 * editable: whether the editor may change things on it (else it is read only); offersBranch: the environment's branch
 * of a `pull-request` server, where the first edit offers Create branch and takes the edit along
 */
export type CurrentBranchView = { branch: string | null; editable: boolean; offersBranch?: true };

export const offersBranch = (branch: string | null, environment: string | null, editor: Editor) =>
    branch !== null && branch === environment && editor.mode === 'pull-request';

const branchView = (branch: string | null, environment: string | null, editor: Editor): CurrentBranchView => ({
    branch,
    editable: canEditBranch(branch, environment, editor),
    ...(offersBranch(branch, environment, editor) ? { offersBranch: true as const } : {}),
});

export async function currentBranchView(db: Database, workspaceId: string, userId: string): Promise<CurrentBranchView> {
    const [git, branch, editor] = await Promise.all([
        gitBranch(db, workspaceId),
        currentBranch(db, workspaceId, userId),
        editorOf(db, workspaceId, userId),
    ]);
    return branchView(branch, git?.branch ?? null, editor);
}

/** why the branch is read only to this user and what to do, in the editor or (`mcp`) told to an agent */
export function readOnlyBranch(branch: string, editor: Editor, environment: string | null, to: 'editor' | 'mcp' = 'editor'): string {
    const { kind, owner } = branchKind(branch, environment ? [...editor.environments, environment] : editor.environments);
    if (to === 'mcp') {
        const why =
            branch === environment
                ? `the branch ${branch} only takes pull requests`
                : editor.mode === 'protected'
                  ? `this server's environment is protected: the branch ${branch} is read only here`
                  : kind === 'user'
                    ? `the branch ${branch} is ${owner}'s: only its owner changes it`
                    : `the branch ${branch} is read only here`;
        return `Your current branch cannot be edited (${why}): pick or create a branch of your own in the editor, then try again.`;
    }
    if (branch === environment) {
        return `${branch} only takes pull requests: create a branch of your own to make changes.`;
    }
    if (editor.mode === 'protected') {
        return `This server's environment is protected: the branch ${branch} is read only here.`;
    }
    return kind === 'user'
        ? `The branch ${branch} is ${owner}'s: only its owner changes it. Create a branch from it to make changes.`
        : `You are on the branch ${branch}, which is read only here: pick the environment's branch to make changes.`;
}

/** why the user cannot change the working copy of their current branch, told to an agent; null where they can */
export async function mcpCannotEdit(db: Database, workspaceId: string, userId: string): Promise<string | null> {
    const [git, branch, editor] = await Promise.all([
        gitBranch(db, workspaceId),
        currentBranch(db, workspaceId, userId),
        editorOf(db, workspaceId, userId),
    ]);
    const environment = git?.branch ?? null;
    return branch === null || canEditBranch(branch, environment, editor) ? null : readOnlyBranch(branch, editor, environment, 'mcp');
}

/**
 * Refused unless the user may edit the branch they are on and it is the environment's branch, for a change made to the
 * tables (they are the environment's branch): on a work branch it would land where they are not looking.
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
    if (branch === null) {
        return;
    }
    const environment = git?.branch ?? null;
    if (!canEditBranch(branch, environment, editor)) {
        throw new UseCaseFailure('conflict', readOnlyBranch(branch, editor, environment));
    }
    if (branch !== environment) {
        throw new UseCaseFailure('conflict', `This change cannot be made on a work branch yet: make it on ${environment}.`);
    }
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
        return success(branchView(branch, git.branch, await editorOf(ctx.db, ctx.workspaceId, ctx.userId)));
    }
}
