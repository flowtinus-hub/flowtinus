import type { TreeIssue } from '@flowtinus/core';
import { workspaceSlug } from '#features/folders/project-tree';
import { deleteWorkspaceSetting, readWorkspaceSetting, writeWorkspaceSetting } from '#features/workspaces/workspace-settings';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { isGitOn, RECONCILE_SETTING, type GitConfig } from './git-config';
import type { GitRemote } from './git-remote';
import type { RepoFiles } from './workspace-export';
import { importWorkspace, readBranchWorkspace, validateImport, type RenamedDraft } from './workspace-import';
import { environmentBranch } from './workspace-topology';

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

type ReconcileState = { applied: string | null; branch?: string; refused: { commit: string; errors: TreeIssue[]; at: string } | null };

const lockKey = (workspaceId: string) => `reconcile:${workspaceId}`;

export const lockReconcile = (db: Database, workspaceId: string) =>
    db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(workspaceId)]);

export async function readState(db: Database, workspaceId: string): Promise<ReconcileState> {
    const state = (await readWorkspaceSetting(db, workspaceId, RECONCILE_SETTING)) as ReconcileState | null;
    return state ?? { applied: null, refused: null };
}

const markApplied = (ctx: UseCaseContext, { branch, commit }: BranchCommit) =>
    writeWorkspaceSetting(ctx.db, ctx.workspaceId, RECONCILE_SETTING, { applied: commit, branch, refused: null }, ctx.userId);

export async function forgetReconcile(ctx: UseCaseContext) {
    await deleteWorkspaceSetting(ctx.db, ctx.workspaceId, RECONCILE_SETTING);
    await ctx.db.query('DELETE FROM deployed_scripts WHERE workspace_id = $1', [ctx.workspaceId]);
}

export type BranchCommit = { branch: string; commit: string };

export async function applyCommit(
    ctx: UseCaseContext,
    remote: GitRemote,
    applied: BranchCommit,
    slug: string,
    files: RepoFiles,
): Promise<RenamedDraft[]> {
    const by = await recordCommit(ctx, remote, applied.commit);
    const { renamedDrafts } = await importWorkspace(ctx, slug, files, { commit: applied.commit, by });
    await markApplied(ctx, applied);
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

export async function reconcile(ctx: UseCaseContext, remote: GitRemote, config: GitConfig): Promise<UseCaseResult<ReconcileResult>> {
    const target = await environmentBranch(remote, config.environment);
    if (!target.ok) {
        return target;
    }

    const { branch, tip } = target.value;
    if (!tip) {
        return fail('conflict', `The branch ${branch} does not exist.`);
    }

    const slug = await workspaceSlug(ctx);
    const files = await readBranchWorkspace(remote, tip, slug);
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
        if (state.applied === tip) {
            return success({ ...result, outcome: 'up-to-date' as const });
        }
        if (state.refused?.commit === tip) {
            return success({ ...result, outcome: 'refused' as const, errors: state.refused.errors, refusedAt: state.refused.at });
        }

        const validation = await validateImport(db, ctx.workspaceId, slug, files);
        if (validation.errors.length > 0) {
            const refused = { commit: tip, errors: validation.errors, at: new Date().toISOString() };
            await writeWorkspaceSetting(db, ctx.workspaceId, RECONCILE_SETTING, { ...state, refused }, ctx.userId);
            return success({ ...result, outcome: 'refused' as const, errors: refused.errors, refusedAt: refused.at });
        }

        const renamedDrafts = await applyCommit(tx, remote, { branch, commit: tip }, slug, files);
        return success({ ...result, outcome: 'applied' as const, warnings: validation.warnings, renamedDrafts });
    });
}
