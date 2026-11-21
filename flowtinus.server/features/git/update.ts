import { saveBlob } from '#features/scripts/script-store';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { onClone, workBranch, type WorkBranch } from './branch-read';
import { branchIds, lockBranch, noteHead, refuseReadOnly } from './branch-write';
import { gitAuthorOf, gitBranch } from './git-config';
import { GitError, type GitRemote } from './git-remote';
import { dropPendingMerge, pendingMerge, pendingMergeRefusal, pendingMergeView, type PendingMerge, type PendingMergeView } from './pending-merge';
import { followGit, isChange, overlayRows, workingRows } from './working-copy';
import type { GitChanges, RepoFiles } from './workspace-export';
import { issueFields, readBranchWorkspace, validateImport } from './workspace-import';

export type UpdateStatus = { branch: string; environment: string; behind: number; pending?: PendingMergeView };

export type UpdateOutcome =
    | { outcome: 'up-to-date' }
    | { outcome: 'merged'; commit: string }
    | { outcome: 'pending'; conflicts: string[]; errors?: Record<string, string> };

const scopeOf = (handle: string) => [handle, '.gitattributes'];

const inScope = (path: string, handle: string) => path.startsWith(`${handle}/`) || path === '.gitattributes';

async function updatable(ctx: UseCaseContext): Promise<{ branch: WorkBranch; environment: string }> {
    const git = await gitBranch(ctx.db, ctx.workspaceId);
    if (!git?.branch) {
        throw new UseCaseFailure('conflict', 'Git is off in this workspace: there are no branches.');
    }
    const branch = await workBranch(ctx);
    if (!branch) {
        throw new UseCaseFailure('conflict', `Update merges ${git.branch} into a work branch: pick or create one first.`);
    }
    await refuseReadOnly(ctx, branch);
    return { branch, environment: git.branch };
}

export async function updateStatus(ctx: UseCaseContext): Promise<UseCaseResult<UpdateStatus>> {
    const { branch, environment } = await updatable(ctx);
    const merge = await pendingMerge(ctx.db, ctx.workspaceId, branch.branch);
    return onClone(ctx, 'Git could not be reached', async remote => {
        const branches = await remote.branches();
        const theirs = await remote.fetch(environment, branches);
        if (!theirs) {
            return fail('conflict', `The branch ${environment} is not in the repository.`);
        }
        const ours = (await remote.fetch(branch.branch, branches)) ?? branch.tip;
        return success({
            branch: branch.branch,
            environment,
            behind: await remote.countBetween(ours, theirs),
            ...(merge ? { pending: pendingMergeView(merge) } : {}),
        });
    });
}

export async function updateBranch(ctx: UseCaseContext): Promise<UseCaseResult<UpdateOutcome>> {
    const { branch, environment } = await updatable(ctx);
    const author = await gitAuthorOf(ctx);
    const handle = branch.handle;
    const scope = scopeOf(handle);
    return onClone(ctx, 'Git could not be reached, nothing was merged', remote =>
        ctx.db.transaction(async (db): Promise<UseCaseResult<UpdateOutcome>> => {
            await lockBranch(db, ctx.workspaceId, branch.branch);
            const waiting = await pendingMerge(db, ctx.workspaceId, branch.branch);
            if (waiting) {
                return fail('conflict', pendingMergeRefusal(waiting));
            }
            const branches = await remote.branches();
            const ours = await remote.fetch(branch.branch, branches);
            if (!ours) {
                return fail('conflict', `The branch ${branch.branch} is not in the repository any more: nothing was merged.`);
            }
            const theirs = await remote.fetch(environment, branches);
            if (!theirs) {
                return fail('conflict', `The branch ${environment} is not in the repository.`);
            }
            const tipFiles = ours === branch.tip ? branch.tipFiles : await readBranchWorkspace(remote, ours, handle);
            await followGit(db, ctx.workspaceId, tipFiles, ours, branch.branch);
            if (ours !== branch.tip) {
                await noteHead(db, ctx.workspaceId, ctx.userId, branch.branch, ours);
            }
            if (await remote.isAncestor(theirs, ours)) {
                return success({ outcome: 'up-to-date' });
            }
            const base = await remote.mergeBase(ours, theirs);
            if (!base) {
                return fail('conflict', `${branch.branch} and ${environment} have no commit in common: merge them in git.`);
            }

            const merge = await remote.mergeTree(ours, theirs);
            const outside = merge.conflicts.filter(path => !inScope(path, handle));
            if (outside.length > 0) {
                return fail(
                    'conflict',
                    `The merge of ${environment} conflicts outside this workspace (${outside.join(', ')}): merge it into ${branch.branch} in git.`,
                );
            }
            const brought = new Set([
                ...(await remote.changedPaths(base, theirs, scope)),
                ...(await remote.changedPaths(ours, merge.tree, scope)),
                ...merge.conflicts,
            ]);
            const held = (await workingRows(db, ctx.workspaceId, branch.branch))
                .filter(r => isChange(r) && brought.has(r.path))
                .map(r => r.path);
            if (held.length > 0) {
                return fail(
                    'conflict',
                    `Update would merge ${environment} over uncommitted changes: commit or discard them first (${held.join(', ')}).`,
                    Object.fromEntries(held.map(path => [path, 'Uncommitted change: commit or discard it first.'])),
                );
            }

            const message = `Merge ${environment} into ${branch.branch}`;
            if (merge.conflicts.length === 0) {
                const commit = await remote.commit({ parent: ours, changes: {}, message, author, merge: { tree: merge.tree, theirs } });
                const files = await readBranchWorkspace(remote, commit, handle);
                const { errors } = await validateImport(db, ctx.workspaceId, handle, files);
                if (errors.length === 0) {
                    const pushed = await pushOrRefuse(remote, commit, branch.branch, ours);
                    if (!pushed.ok) {
                        return pushed;
                    }
                    await noteHead(db, ctx.workspaceId, ctx.userId, branch.branch, commit);
                    await followGit(db, ctx.workspaceId, files, commit, branch.branch);
                    return success({ outcome: 'merged', commit });
                }
                await holdMerge(db, ctx, remote, { branch: branch.branch, handle, ours, theirs, base, environment, tipFiles, ...merge });
                return success({ outcome: 'pending', conflicts: [], errors: issueFields(errors) });
            }
            const pending = await holdMerge(db, ctx, remote, {
                branch: branch.branch,
                handle,
                ours,
                theirs,
                base,
                environment,
                tipFiles,
                ...merge,
            });
            return success({ outcome: 'pending', conflicts: pending.conflicts });
        }),
    );
}

async function pushOrRefuse(remote: GitRemote, commit: string, branch: string, from: string): Promise<UseCaseResult<void>> {
    try {
        await remote.push(commit, branch, from);
        return success(undefined);
    } catch (e) {
        if (e instanceof GitError && (await remote.branches()).get(branch) !== from) {
            return fail('conflict', `The branch ${branch} moved during the push: nothing was committed, try again.`);
        }
        throw e;
    }
}

// marked as a moved branch marks a file: row.base, row.content and the file at row.conflict are the three texts
async function holdMerge(
    db: Database,
    ctx: UseCaseContext,
    remote: GitRemote,
    merge: {
        branch: string;
        handle: string;
        ours: string;
        theirs: string;
        base: string;
        environment: string;
        tipFiles: RepoFiles;
        tree: string;
        conflicts: string[];
    },
): Promise<PendingMerge> {
    const scope = scopeOf(merge.handle);
    const baseFiles = await readBranchWorkspace(remote, merge.base, merge.handle);
    const theirsFiles = await readBranchWorkspace(remote, merge.theirs, merge.handle);
    const mergedFiles = await remote.files(merge.tree, scope);
    // a conflicted file's merged text has markers and reads as nothing: its id comes from either side
    const ids = {
        ...branchIds(theirsFiles, merge.handle),
        ...branchIds(merge.tipFiles, merge.handle),
        ...branchIds(mergedFiles, merge.handle),
    };
    const paths = [...new Set([...(await remote.changedPaths(merge.ours, merge.tree, scope)), ...merge.conflicts])].sort();

    const written: string[] = [];
    const conflicts: string[] = [];
    for (const path of paths) {
        const ours = merge.tipFiles[path];
        let row: { content: string; deleted: boolean; base: string | undefined; conflict: string | null };
        if (merge.conflicts.includes(path)) {
            const base = baseFiles[path];
            const theirs = theirsFiles[path];
            if (ours === undefined && base === undefined && theirs === undefined) {
                continue;
            }
            row = { content: ours ?? theirs ?? base!, deleted: ours === undefined && base !== undefined, base, conflict: merge.theirs };
        } else {
            const merged = mergedFiles[path];
            if (merged === undefined && ours === undefined) {
                continue;
            }
            row = { content: merged ?? ours!, deleted: merged === undefined, base: ours, conflict: null };
        }
        await db.query(
            `INSERT INTO working_copy (workspace_id, branch, path, content, deleted, file_id, base, edited_by, conflict, revision)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
           ON CONFLICT (workspace_id, branch, path) DO UPDATE SET content = EXCLUDED.content, deleted = EXCLUDED.deleted,
             file_id = EXCLUDED.file_id, base = EXCLUDED.base, edited_by = EXCLUDED.edited_by, conflict = EXCLUDED.conflict,
             revision = working_copy.revision + 1, updated_at = now()`,
            [
                ctx.workspaceId,
                merge.branch,
                path,
                row.content,
                row.deleted,
                ids[path] ?? null,
                row.base === undefined ? null : await saveBlob(db, ctx.workspaceId, row.base),
                ctx.userId,
                row.conflict,
            ],
        );
        written.push(path);
        if (row.conflict) {
            conflicts.push(path);
        }
    }
    await db.query(
        `INSERT INTO pending_merges (workspace_id, branch, ours, theirs, source, paths, conflicts, merged_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ctx.workspaceId, merge.branch, merge.ours, merge.theirs, merge.environment, written, conflicts, ctx.userId],
    );
    return {
        branch: merge.branch,
        ours: merge.ours,
        theirs: merge.theirs,
        source: merge.environment,
        paths: written,
        conflicts,
        mergedBy: ctx.userId,
        createdAt: new Date(),
    };
}

export async function commitPendingMerge(ctx: UseCaseContext, branch: WorkBranch, message: string): Promise<UseCaseResult<string>> {
    const author = await gitAuthorOf(ctx);
    const scope = scopeOf(branch.handle);
    return onClone(ctx, 'Git could not be reached, nothing was committed', remote =>
        ctx.db.transaction(async (db): Promise<UseCaseResult<string>> => {
            await lockBranch(db, ctx.workspaceId, branch.branch);
            const merge = await pendingMerge(db, ctx.workspaceId, branch.branch);
            if (!merge) {
                return fail('conflict', `No merge is pending on ${branch.branch} any more.`);
            }
            const rows = await workingRows(db, ctx.workspaceId, branch.branch);
            const conflicted = rows.find(r => r.conflict);
            if (conflicted) {
                return fail(
                    'conflict',
                    `${conflicted.path} conflicts with ${merge.source}'s commit ${conflicted.conflict!.slice(0, 7)}: resolve or discard it first. The merge is committed whole.`,
                );
            }
            const tip = await remote.fetch(branch.branch);
            if (!tip) {
                return fail('conflict', `The branch ${branch.branch} is not in the repository any more: nothing was committed.`);
            }
            if (tip !== merge.ours) {
                return fail(
                    'conflict',
                    `${branch.branch} moved since the Update (now ${tip.slice(0, 7)}): Discard all to abort the merge, then Update again.`,
                );
            }
            if (!(await remote.hasCommit(merge.theirs))) {
                await remote.fetch(merge.source);
            }
            const tipFiles = tip === branch.tip ? branch.tipFiles : await readBranchWorkspace(remote, tip, branch.handle);
            const { tree } = await remote.mergeTree(merge.ours, merge.theirs);
            const mergedFiles = await remote.files(tree, scope);
            const wanted = overlayRows(tipFiles, rows);
            const changes: GitChanges = {};
            for (const path of new Set([...Object.keys(mergedFiles), ...Object.keys(wanted)])) {
                if (wanted[path] !== mergedFiles[path]) {
                    changes[path] = wanted[path] ?? null;
                }
            }

            const commit = await remote.commit({ parent: tip, changes, message, author, merge: { tree, theirs: merge.theirs } });
            const files = await readBranchWorkspace(remote, commit, branch.handle);
            const { errors } = await validateImport(db, ctx.workspaceId, branch.handle, files);
            if (errors.length > 0) {
                return fail(
                    'validation',
                    `The merge commit on ${branch.branch} would not be valid: nothing was committed.`,
                    issueFields(errors),
                );
            }
            const pushed = await pushOrRefuse(remote, commit, branch.branch, tip);
            if (!pushed.ok) {
                return pushed;
            }
            for (const row of rows) {
                await db.query(
                    `UPDATE working_copy SET base = $4, conflict = NULL, updated_at = now() WHERE workspace_id = $1 AND branch = $2 AND path = $3`,
                    [ctx.workspaceId, branch.branch, row.path, row.deleted ? null : await saveBlob(db, ctx.workspaceId, row.content ?? '')],
                );
            }
            await dropPendingMerge(db, ctx.workspaceId, branch.branch);
            await noteHead(db, ctx.workspaceId, ctx.userId, branch.branch, commit);
            return success(commit);
        }),
    );
}

// called under the branch's lock
export async function abortMerge(db: Database, ctx: UseCaseContext, branch: WorkBranch, merge: PendingMerge): Promise<void> {
    await db.query('DELETE FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND path = ANY($3::text[])', [
        ctx.workspaceId,
        branch.branch,
        merge.paths,
    ]);
    await dropPendingMerge(db, ctx.workspaceId, branch.branch);
    // the polls left the branch's working copy alone while the merge was pending: onto its tip now
    await followGit(db, ctx.workspaceId, branch.tipFiles, branch.tip, branch.branch);
}
