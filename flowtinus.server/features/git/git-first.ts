import { workspaceSlug } from '#features/folders/project-tree';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import { gitAccess, gitAuthorOf, readGitState, type GitConfig } from './git-config';
import { GitError, withWorkspaceClone, type GitRemote } from './git-remote';
import { applyCommit, lockReconcile, readState } from './reconcile';
import { exportWorkspace, repoChanges, type FlowToCommit, type GitChanges } from './workspace-export';
import { issueFields, readBranchWorkspace, validateImport } from './workspace-import';
import { environmentBranch } from './workspace-topology';

type OnGit = { workspaceId: string; config: GitConfig };

type Cloned = OnGit & { remote: GitRemote };

export async function changeTree<T>(
    ctx: UseCaseContext,
    message: (value: NoInfer<T>) => string,
    change: (db: Database) => Promise<T>,
    also: string[] = [],
): Promise<T> {
    const onGit: OnGit[] = [];
    for (const workspaceId of [...new Set([ctx.workspaceId, ...also])].sort()) {
        const state = await readGitState(ctx.db, workspaceId);
        if (state?.on) {
            onGit.push({ workspaceId, config: state.config });
        }
    }

    return withClones(ctx, onGit, [], remotes =>
        ctx.db.transaction(async tx => {
            const before = [];
            for (const { workspaceId, config, remote } of remotes) {
                await lockReconcile(tx, workspaceId);
                await catchUp({ ...ctx, db: tx, workspaceId }, config, remote);
                before.push(await exportWorkspace(tx, workspaceId));
            }

            const value = await change(tx);
            for (const [i, { workspaceId, config, remote }] of remotes.entries()) {
                const changes = repoChanges(before[i]!, await exportWorkspace(tx, workspaceId));
                if (Object.keys(changes).length > 0) {
                    await commitFirst({ ...ctx, db: tx, workspaceId }, config, remote, message(value), changes);
                }
            }
            return value;
        }),
    );
}

/**
 * Commits flows' files as `flows` gives them (worked out once git's newer commit is applied), then reconciles that
 * commit, which deploys them. Answers the commit applied; nothing to change answers null.
 */
export async function commitFlows(
    ctx: UseCaseContext,
    message: string,
    flows: (db: Database) => Promise<Map<string, FlowToCommit>>,
): Promise<string | null> {
    const state = await readGitState(ctx.db, ctx.workspaceId);
    if (!state?.on) {
        throw new UseCaseFailure('conflict', 'Git is off in this workspace.');
    }

    return withClones(ctx, [{ workspaceId: ctx.workspaceId, config: state.config }], [], ([cloned]) =>
        ctx.db.transaction(async tx => {
            const { config, remote } = cloned!;
            const at = { ...ctx, db: tx };
            await lockReconcile(tx, ctx.workspaceId);
            await catchUp(at, config, remote);
            const before = await exportWorkspace(tx, ctx.workspaceId);
            const changes = repoChanges(before, await exportWorkspace(tx, ctx.workspaceId, await flows(tx)));
            return Object.keys(changes).length > 0 ? commitFirst(at, config, remote, message, changes) : null;
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

async function branchTip(remote: GitRemote, config: GitConfig): Promise<{ branch: string; tip: string }> {
    const target = await environmentBranch(remote, config.environment);
    if (!target.ok) {
        throw new UseCaseFailure(target.error.code, target.error.message);
    }
    if (!target.value.tip) {
        throw new UseCaseFailure('conflict', `The branch ${target.value.branch} does not exist.`);
    }
    return { branch: target.value.branch, tip: target.value.tip };
}

// the change is worked out on the workspace as git has it: a commit made in git since the last reconcile is applied
// first, or the change's files would overwrite it; a tip that is not valid is left to the validation of the change
async function catchUp(ctx: UseCaseContext, config: GitConfig, remote: GitRemote): Promise<void> {
    const { branch, tip } = await branchTip(remote, config);
    const state = await readState(ctx.db, ctx.workspaceId);
    if (tip === state.applied || tip === state.refused?.commit) {
        return;
    }

    const slug = await workspaceSlug(ctx);
    const files = await readBranchWorkspace(remote, tip, slug);
    if ((await validateImport(ctx.db, ctx.workspaceId, slug, files)).errors.length === 0) {
        await applyCommit(ctx, remote, { branch, commit: tip }, slug, files);
    }
}

export async function commitFirst(
    ctx: UseCaseContext,
    config: GitConfig,
    remote: GitRemote,
    message: string,
    changes: GitChanges,
): Promise<string> {
    const slug = await workspaceSlug(ctx);
    const author = await gitAuthorOf(ctx);
    let moved: string | null = null;
    for (;;) {
        const { branch, tip } = await branchTip(remote, config);
        if (moved) {
            const touched = (await remote.run(['diff', '--name-only', '-z', moved, tip])).split('\0').filter(path => path in changes);
            if (touched.length > 0) {
                throw new UseCaseFailure('conflict', `${touched.join(', ')} changed in git meanwhile: nothing was changed, try again.`);
            }
        }

        const commit = await remote.commit({ parent: tip, changes, message, author });
        const files = await readBranchWorkspace(remote, commit, slug);
        const { errors } = await validateImport(ctx.db, ctx.workspaceId, slug, files);
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

        await applyCommit(ctx, remote, { branch, commit }, slug, files);
        return commit;
    }
}
