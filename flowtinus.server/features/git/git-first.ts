import { workspaceHandle } from '#features/folders/project-tree';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import { fail, success, type UseCaseError, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { gitAccess, gitAuthorOf, readGitState, type GitConfig } from './git-config';
import { GitError, withWorkspaceClone, type GitRemote } from './git-remote';
import { applyCommit, lockReconcile, readState } from './reconcile';
import { exportTree, type GitChanges, type RepoFiles } from './workspace-export';
import { recordChanges } from './working-copy';
import { refuseOffEditableBranch } from './current-branch';
import { issueFields, readBranchWorkspace, validateImport } from './workspace-import';
import { environmentBranch } from './workspace-topology';
import type { Mode } from './topology';

type OnGit = { workspaceId: string; config: GitConfig };

type Cloned = OnGit & { remote: GitRemote };

export async function changeTree<T>(ctx: UseCaseContext, change: (db: Database) => Promise<T>, also: string[] = []): Promise<T> {
    const workspaceIds = [...new Set([ctx.workspaceId, ...also])].sort();
    await refuseOffEditableBranch(ctx.db, ctx.workspaceId, ctx.userId);
    return ctx.db.transaction(async tx => {
        const before = [];
        for (const workspaceId of workspaceIds) {
            await refuseUnlessDirectState(tx, workspaceId);
            before.push(await exportTree(tx, workspaceId));
        }
        const value = await change(tx);
        for (const [i, workspaceId] of workspaceIds.entries()) {
            await recordChanges(tx, workspaceId, before[i]!, await exportTree(tx, workspaceId), ctx.userId);
        }
        return value;
    });
}

// the mode as the last reconcile read it from the topology: no clone, so that a change works while git is down
async function refuseUnlessDirectState(db: Database, workspaceId: string): Promise<void> {
    const state = await readGitState(db, workspaceId);
    const mode = state?.on ? (await readState(db, workspaceId)).mode : undefined;
    if (state && mode && mode !== 'direct') {
        throw new UseCaseFailure('conflict', onlyPullRequests(state.config.environment));
    }
}

/**
 * A commit on the branch's tip of the changes `work` works out (once git's newer commit is applied, from the tip's
 * files), then the reconcile of that commit. Answers the commit, or null when nothing changes; `work` may refuse:
 * what the catch-up applied is kept, nothing is committed.
 */
export async function commitTree(
    ctx: UseCaseContext,
    message: string,
    work: (db: Database, tip: RepoFiles) => Promise<{ changes: GitChanges } | UseCaseError>,
): Promise<UseCaseResult<string | null>> {
    const state = await readGitState(ctx.db, ctx.workspaceId);
    if (!state?.on) {
        return fail('conflict', 'Git is off in this workspace.');
    }

    return withClones(ctx, [{ workspaceId: ctx.workspaceId, config: state.config }], [], ([cloned]) =>
        ctx.db.transaction(async (tx): Promise<UseCaseResult<string | null>> => {
            const { config, remote } = cloned!;
            const at = { ...ctx, db: tx };
            await lockReconcile(tx, ctx.workspaceId);
            const target = await branchTip(remote, config);
            if (target.mode !== 'direct') {
                throw new UseCaseFailure('conflict', onlyPullRequests(config.environment));
            }
            await catchUp(at, remote, target);
            const worked = await work(tx, await readBranchWorkspace(remote, target.tip, await workspaceHandle(at)));
            if (!('changes' in worked)) {
                return { ok: false, error: worked };
            }
            const { changes } = worked;
            return success(Object.keys(changes).length > 0 ? await commitFirst(at, config, remote, message, changes, target) : null);
        }),
    );
}

// each clone is held for the whole change, taken before the transaction as the reconcile takes them: one order, no deadlock
async function withClones<T>(ctx: UseCaseContext, pending: OnGit[], opened: Cloned[], work: (opened: Cloned[]) => Promise<T>): Promise<T> {
    const [next, ...rest] = pending;
    if (!next) {
        return work(opened);
    }
    if (!ctx.git) {
        throw new UseCaseFailure('unavailable', 'Git is on, but this server has no git options.');
    }

    const access = await gitAccess({ ...ctx, workspaceId: next.workspaceId }, next.config);
    if (!access.ok) {
        throw new UseCaseFailure(access.error.code, access.error.message);
    }

    try {
        return await withWorkspaceClone(ctx.git.clonesDir, next.workspaceId, access.value, remote =>
            withClones(ctx, rest, [...opened, { ...next, remote }], work),
        );
    } catch (e) {
        if (e instanceof GitError) {
            throw new UseCaseFailure('unavailable', `Git could not be reached, nothing was changed: ${e.message}`);
        }
        throw e;
    }
}

type BranchTip = { branch: string; tip: string; mode: Mode };

async function branchTip(remote: GitRemote, config: GitConfig): Promise<BranchTip> {
    const target = await environmentBranch(remote, config.environment);
    if (!target.ok) {
        throw new UseCaseFailure(target.error.code, target.error.message);
    }
    if (!target.value.tip) {
        throw new UseCaseFailure('conflict', `The branch ${target.value.branch} does not exist.`);
    }
    return { branch: target.value.branch, tip: target.value.tip, mode: target.value.mode };
}

export const onlyPullRequests = (environment: string) => `${environment} only takes pull requests: edit in git.`;

// the change is worked out on the workspace as git has it: a commit made in git since the last reconcile is applied
// first, or the change's files would overwrite it; a tip that is not valid is left to the validation of the change
async function catchUp(ctx: UseCaseContext, remote: GitRemote, { branch, tip, mode }: BranchTip): Promise<void> {
    const state = await readState(ctx.db, ctx.workspaceId);
    if (tip === state.applied || tip === state.refused?.commit) {
        return;
    }

    const handle = await workspaceHandle(ctx);
    const files = await readBranchWorkspace(remote, tip, handle);
    const { errors, warnings } = await validateImport(ctx.db, ctx.workspaceId, handle, files);
    if (errors.length === 0) {
        await applyCommit(ctx, remote, { branch, commit: tip, mode }, handle, files, warnings);
    }
}

export async function commitFirst(
    ctx: UseCaseContext,
    config: GitConfig,
    remote: GitRemote,
    message: string,
    changes: GitChanges,
    fetched?: BranchTip,
): Promise<string> {
    const handle = await workspaceHandle(ctx);
    const author = await gitAuthorOf(ctx);
    let moved: string | null = null;
    for (;;) {
        const { branch, tip, mode }: BranchTip = !moved && fetched ? fetched : await branchTip(remote, config);
        if (moved) {
            const touched = (await remote.run(['diff', '--name-only', '-z', moved, tip])).split('\0').filter(path => path in changes);
            if (touched.length > 0) {
                throw new UseCaseFailure('conflict', `${touched.join(', ')} changed in git meanwhile: nothing was changed, try again.`);
            }
        }

        const commit = await remote.commit({ parent: tip, changes, message, author });
        const files = await readBranchWorkspace(remote, commit, handle);
        const { errors, warnings } = await validateImport(ctx.db, ctx.workspaceId, handle, files);
        if (errors.length > 0) {
            throw new UseCaseFailure('validation', `The commit on ${branch} would not be valid: nothing was changed.`, issueFields(errors));
        }

        try {
            if (commit !== tip) {
                await remote.push(commit, branch, tip);
            }
        } catch (e) {
            if (!(e instanceof GitError) || (await remote.branches()).get(branch) === tip) {
                throw e;
            }
            if (moved) {
                throw new UseCaseFailure('conflict', `The branch ${branch} moved again during the push: nothing was changed, try again.`);
            }
            moved = tip;
            continue;
        }

        await applyCommit(ctx, remote, { branch, commit, mode }, handle, files, warnings);
        return commit;
    }
}
