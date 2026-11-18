import type { TreeIssue } from '@flowtinus/core';
import { workspaceSlug } from '#features/folders/project-tree';
import { deleteWorkspaceSetting, readWorkspaceSetting, writeWorkspaceSetting } from '#features/workspaces/workspace-settings';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { isGitOn, type GitConfig } from './git-config';
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

type ReconcileState = { applied: string | null; refused: { commit: string; errors: TreeIssue[]; at: string } | null };

const RECONCILE_SETTING = 'git-reconcile';

const lockKey = (workspaceId: string) => `reconcile:${workspaceId}`;

export const lockReconcile = (db: Database, workspaceId: string) =>
    db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(workspaceId)]);

export async function readState(db: Database, workspaceId: string): Promise<ReconcileState> {
    const state = (await readWorkspaceSetting(db, workspaceId, RECONCILE_SETTING)) as ReconcileState | null;
    return state ?? { applied: null, refused: null };
}

const markApplied = (ctx: UseCaseContext, commit: string) =>
    writeWorkspaceSetting(ctx.db, ctx.workspaceId, RECONCILE_SETTING, { applied: commit, refused: null }, ctx.userId);

export async function forgetReconcile(ctx: UseCaseContext) {
    await deleteWorkspaceSetting(ctx.db, ctx.workspaceId, RECONCILE_SETTING);
    await ctx.db.query('DELETE FROM deployed_scripts WHERE workspace_id = $1', [ctx.workspaceId]);
}

export async function applyCommit(ctx: UseCaseContext, slug: string, commit: string, files: RepoFiles): Promise<RenamedDraft[]> {
    const { renamedDrafts } = await importWorkspace(ctx, slug, files, { commit });
    await markApplied(ctx, commit);
    return renamedDrafts;
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

        const renamedDrafts = await applyCommit(tx, slug, tip, files);
        return success({ ...result, outcome: 'applied' as const, warnings: validation.warnings, renamedDrafts });
    });
}
