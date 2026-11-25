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

export type BranchKind = 'environment' | 'app' | 'hotfix' | 'backport' | 'user' | 'shared';

export const HOTFIX_PREFIX = 'hotfix/';

export const shortSha = (sha: string) => sha.slice(0, 12);

const BACKPORT = /^backport\/(.+)-[0-9a-f]{12}$/;

export const backportBranch = (from: string, sha: string) => `backport/${from}-${shortSha(sha)}`;

export const opensIntoEnvironment = (kind: BranchKind) => kind === 'hotfix' || kind === 'backport';

/** from: a backport's environment, the one ahead it merges from */
export function branchKind(name: string, environments: string[]): { kind: BranchKind; owner?: string; from?: string } {
    if (environments.includes(name)) {
        return { kind: 'environment' };
    }
    if (name.startsWith(HOTFIX_PREFIX)) {
        return { kind: 'hotfix' };
    }
    const backport = BACKPORT.exec(name);
    if (backport) {
        return { kind: 'backport', from: backport[1]! };
    }
    if (/^(promote|repair|backport|flowtinus)\//.test(name)) {
        return { kind: 'app' };
    }
    const user = /^users\/([^/]+)\/./.exec(name);
    return user ? { kind: 'user', owner: user[1]! } : { kind: 'shared' };
}

/** targets: the environments this server's environment promotes to: a backport from one of them is shared here, whatever the mode */
export type Editor = { handle: string | null; environments: string[]; targets: string[]; mode: Mode };

export function canEditBranch(branch: string | null, environment: string | null, editor: Editor): boolean {
    if (branch === null) {
        return true;
    }
    if (branch === environment) {
        return editor.mode !== 'pull-request';
    }
    const { kind, owner, from } = branchKind(branch, environment ? [...editor.environments, environment] : editor.environments);
    if (kind === 'backport') {
        return editor.targets.includes(from!);
    }
    return sharedHere(kind, editor) || (editor.mode !== 'protected' && kind === 'user' && owner === editor.handle);
}

export const sharedHere = (kind: BranchKind, editor: Pick<Editor, 'mode'>) =>
    editor.mode === 'protected' ? kind === 'hotfix' : kind === 'shared';

export const listedHere = (name: string, kind: BranchKind, environment: string | null, editor: Pick<Editor, 'mode'>) =>
    editor.mode === 'protected' ? name === environment || opensIntoEnvironment(kind) : kind !== 'app' && kind !== 'hotfix';

export async function editorOf(db: Database, workspaceId: string, userId: string): Promise<Editor> {
    const [[me], heads, git] = await Promise.all([
        db.query<{ handle: string }>('SELECT handle FROM users WHERE id::text = $1', [userId]),
        readHeads(db, workspaceId),
        gitBranch(db, workspaceId),
    ]);
    return {
        handle: me?.handle ?? null,
        environments: heads?.environments ?? [],
        targets: heads?.targets ?? [],
        mode: git?.mode ?? 'direct',
    };
}

export type CurrentBranchView = { branch: string | null; editable: boolean; removed?: true; lostTip?: true; offersBranch?: true };

export const offersBranch = (branch: string | null, environment: string | null, editor: Editor) =>
    branch !== null && branch === environment && editor.mode === 'pull-request';

export async function branchAccess(
    db: Database,
    workspaceId: string,
    userId: string,
): Promise<{ branch: string | null; mayChange: boolean; removed: boolean; lostTip: boolean }> {
    const [git, branch, editor, heads] = await Promise.all([
        gitBranch(db, workspaceId),
        currentBranch(db, workspaceId, userId),
        editorOf(db, workspaceId, userId),
        readHeads(db, workspaceId),
    ]);
    const head = branch === null ? undefined : heads?.heads.find(h => h.name === branch && h.removed);
    return {
        branch,
        mayChange: canEditBranch(branch, git?.branch ?? null, editor),
        removed: head !== undefined,
        lostTip: head?.lostTip === true,
    };
}

export async function currentBranchView(db: Database, workspaceId: string, userId: string): Promise<CurrentBranchView> {
    const [{ branch, mayChange, removed, lostTip }, git, editor] = await Promise.all([
        branchAccess(db, workspaceId, userId),
        gitBranch(db, workspaceId),
        editorOf(db, workspaceId, userId),
    ]);
    return {
        branch,
        editable: mayChange && !removed,
        ...(removed ? { removed: true as const } : {}),
        ...(lostTip ? { lostTip: true as const } : {}),
        ...(offersBranch(branch, git?.branch ?? null, editor) ? { offersBranch: true as const } : {}),
    };
}

export function readOnlyBranch(branch: string, editor: Editor, environment: string | null, to: 'editor' | 'mcp' = 'editor'): string {
    const { kind, owner } = branchKind(branch, environment ? [...editor.environments, environment] : editor.environments);
    if (to === 'mcp') {
        const why =
            branch === environment
                ? `the branch ${branch} only takes pull requests`
                : kind === 'backport'
                  ? `the backport ${branch} is changed only on the server of the environment it goes into`
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
    if (kind === 'backport') {
        return `The backport ${branch} is read only here: only the server of the environment it goes into changes it.`;
    }
    if (editor.mode === 'protected') {
        return `This server's environment is protected: the branch ${branch} is read only here.`;
    }
    return kind === 'user'
        ? `The branch ${branch} is ${owner}'s: only its owner changes it. Create a branch from it to make changes.`
        : `You are on the branch ${branch}, which is read only here: pick the environment's branch to make changes.`;
}

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
 * tables (they are the environment's branch): on a work branch it would land where they are not looking. A `discard`
 * is also let through on a `pull-request` server's environment branch, where the changes made before the mode changed
 * stay until taken to a branch or discarded.
 */
export async function refuseOffEditableBranch(
    db: Database,
    workspaceId: string,
    userId: string | null,
    { discard = false }: { discard?: boolean } = {},
): Promise<void> {
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
    if (discard && offersBranch(branch, environment, editor)) {
        return;
    }
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
        return success(await currentBranchView(ctx.db, ctx.workspaceId, ctx.userId));
    }
}
