import { repoEntry, type TreeIssue } from '@flowtinus/core';
import { workspaceHandle } from '#features/folders/project-tree';
import { foldOverrides } from '#features/schedules/schedules';
import { clearArrivedDisabled } from './arrived-disabled';
import { deleteWorkspaceSetting, readWorkspaceSetting, writeWorkspaceSetting } from '#features/workspaces/workspace-settings';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { HEADS_SETTING, isGitOn, POLL_SETTING, RECONCILE_SETTING, type GitConfig } from './git-config';
import type { GitRemote } from './git-remote';
import { exportTree, type RepoFiles } from './workspace-export';
import { fileRow, writeFile } from './working-copy';
import { importWorkspace, readBranchWorkspace, validateImport, type RenamedDraft } from './workspace-import';
import { environmentBranch } from './workspace-topology';
import type { Mode } from './topology';

export type ReconcileOutcome = 'applied' | 'up-to-date' | 'refused';

export type ReconcileResult = {
    outcome: ReconcileOutcome;
    branch: string;
    commit: string;
    errors: TreeIssue[];
    warnings: TreeIssue[];
    renamedDrafts: RenamedDraft[];
    refusedAt?: string;
};

/** warnings: the last commit applied's (a connection not configured, a secret with no value) */
type ReconcileState = {
    applied: string | null;
    branch?: string;
    mode?: Mode;
    refused: { commit: string; errors: TreeIssue[]; at: string } | null;
    warnings?: TreeIssue[];
};

const lockKey = (workspaceId: string) => `reconcile:${workspaceId}`;

export const lockReconcile = (db: Database, workspaceId: string) =>
    db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(workspaceId)]);

export async function readState(db: Database, workspaceId: string): Promise<ReconcileState> {
    const state = (await readWorkspaceSetting(db, workspaceId, RECONCILE_SETTING)) as ReconcileState | null;
    return state ?? { applied: null, refused: null };
}

const markApplied = (ctx: UseCaseContext, { branch, commit, mode }: BranchCommit, warnings: TreeIssue[]) =>
    writeWorkspaceSetting(
        ctx.db,
        ctx.workspaceId,
        RECONCILE_SETTING,
        { applied: commit, branch, mode, refused: null, warnings },
        ctx.userId,
    );

export async function forgetReconcile(ctx: UseCaseContext) {
    // the work branches' rows and the users' current branches stay, unread until git is on again
    const tree = await exportTree(ctx.db, ctx.workspaceId);
    for (const [path, content] of Object.entries(tree.files)) {
        const fileId = tree.ids[path];
        if (repoEntry(path).kind === 'script' && fileId && !(await fileRow(ctx.db, ctx.workspaceId, fileId))) {
            await writeFile(ctx.db, ctx.workspaceId, { path, content, fileId, userId: ctx.userId, committed: content, revision: 0 });
        }
    }
    await deleteWorkspaceSetting(ctx.db, ctx.workspaceId, RECONCILE_SETTING);
    await deleteWorkspaceSetting(ctx.db, ctx.workspaceId, POLL_SETTING);
    await deleteWorkspaceSetting(ctx.db, ctx.workspaceId, HEADS_SETTING);
    await ctx.db.query('DELETE FROM deployed_scripts WHERE workspace_id = $1', [ctx.workspaceId]);
    await foldOverrides(ctx.db, ctx.workspaceId);
    await clearArrivedDisabled(ctx.db, ctx.workspaceId);
}

/** mode: the environment's in the topology, kept for the editor (the refusal reads the topology itself) */
export type BranchCommit = { branch: string; commit: string; mode?: Mode };

export async function applyCommit(
    ctx: UseCaseContext,
    remote: GitRemote,
    applied: BranchCommit,
    handle: string,
    files: RepoFiles,
    warnings: TreeIssue[] = [],
): Promise<RenamedDraft[]> {
    const by = await recordCommit(ctx, remote, applied.commit);
    const { renamedDrafts } = await importWorkspace(ctx, handle, files, { commit: applied.commit, by });
    await markApplied(ctx, applied, warnings);
    return renamedDrafts;
}

// the commit's author is the app user with that email, if there is one
async function recordCommit(ctx: UseCaseContext, remote: GitRemote, commit: string): Promise<string | null> {
    const [name, email, at, message] = (await remote.run(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%B', commit])).split('\0');
    await ctx.db.query(
        `INSERT INTO git_commits (workspace_id, sha, message, author_name, author_email, authored_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [ctx.workspaceId, commit, (message ?? '').trim(), name, email, at],
    );
    const [user] = await ctx.db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
    return user?.id ?? null;
}

export async function reconcile(
    ctx: UseCaseContext,
    remote: GitRemote,
    config: GitConfig,
    branches?: Map<string, string>,
): Promise<UseCaseResult<ReconcileResult>> {
    const target = await environmentBranch(remote, config.environment, branches);
    if (!target.ok) {
        return target;
    }

    const { branch, tip, mode } = target.value;
    if (!tip) {
        return fail('conflict', `The branch ${branch} does not exist.`);
    }

    const handle = await workspaceHandle(ctx);
    const files = await readBranchWorkspace(remote, tip, handle);
    return ctx.db.transaction(async db => {
        const tx = { ...ctx, db };
        const [lock] = await db.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [
            lockKey(ctx.workspaceId),
        ]);
        if (!lock!.locked) {
            return fail('conflict', 'A reconcile of this workspace is already running.');
        }
        if (!(await isGitOn(db, ctx.workspaceId))) {
            return fail('conflict', 'Git is off in this workspace.');
        }

        const result = { branch, commit: tip, errors: [], warnings: [], renamedDrafts: [] };
        const state = await readState(db, ctx.workspaceId);
        // a topology commit can change the mode (or the branch) without a new commit on the branch
        if (state.mode !== mode || state.branch !== branch) {
            await writeWorkspaceSetting(db, ctx.workspaceId, RECONCILE_SETTING, { ...state, branch, mode }, ctx.userId);
        }
        if (state.applied === tip) {
            return success({ ...result, outcome: 'up-to-date' as const });
        }
        if (state.refused?.commit === tip) {
            return success({ ...result, outcome: 'refused' as const, errors: state.refused.errors, refusedAt: state.refused.at });
        }

        const validation = await validateImport(db, ctx.workspaceId, handle, files);
        if (validation.errors.length > 0) {
            await recordCommit(tx, remote, tip);
            const refused = { commit: tip, errors: validation.errors, at: new Date().toISOString() };
            await writeWorkspaceSetting(db, ctx.workspaceId, RECONCILE_SETTING, { ...state, refused }, ctx.userId);
            return success({ ...result, outcome: 'refused' as const, errors: refused.errors, refusedAt: refused.at });
        }

        const renamedDrafts = await applyCommit(tx, remote, { branch, commit: tip, mode }, handle, files, validation.warnings);
        return success({ ...result, outcome: 'applied' as const, warnings: validation.warnings, renamedDrafts });
    });
}
