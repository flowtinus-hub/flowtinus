import { deleteWorkspaceSetting, readWorkspaceSetting, writeWorkspaceSetting } from '#features/workspaces/workspace-settings';
import type { Database } from '#shared/database/database';
import { pgJson } from '#shared/database/jsonb';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { gitAccess, gitAuthorOf, readGitConfig, type GitOptions } from './git-config';
import { GitError, withWorkspaceClone, type GitRemote } from './git-remote';
import { CONFIG_BRANCH } from './topology';
import { readTopology } from './workspace-topology';

export type GitChanges = Record<string, string | null>;

/** git behind: commits not pushed yet, and why the last push failed */
export type GitSyncView = { pending: number; reason: string | null; since: string | null };

const SYNC_SETTING = 'git-sync';

/**
 * a commit on the environment's branch, in the transaction of the change it mirrors (ctx.db), pushed by
 * pushPendingCommits; nothing when the workspace has no git configured
 */
export async function queueGitCommit(
    ctx: UseCaseContext,
    commit: { message: string; changes: () => Promise<GitChanges> },
): Promise<boolean> {
    if (!(await readGitConfig(ctx.db, ctx.workspaceId))) {
        return false;
    }

    const author = await gitAuthorOf(ctx);
    await ctx.db.query(
        `INSERT INTO git_pending_commits (workspace_id, message, changes, author_name, author_email) VALUES ($1, $2, $3::text::jsonb, $4, $5)`,
        [ctx.workspaceId, commit.message, pgJson(await commit.changes()), author?.name ?? null, author?.email ?? null],
    );
    return true;
}

type PendingRow = { id: string; message: string; changes: GitChanges; author_name: string | null; author_email: string | null };

const pendingCommits = (db: Database, workspaceId: string) =>
    db.query<PendingRow>(
        'SELECT id, message, changes, author_name, author_email FROM git_pending_commits WHERE workspace_id = $1 ORDER BY id',
        [workspaceId],
    );

export async function gitSyncStatus(db: Database, workspaceId: string): Promise<GitSyncView> {
    const [[row], behind] = await Promise.all([
        db.query<{ count: number }>('SELECT count(*)::int AS count FROM git_pending_commits WHERE workspace_id = $1', [workspaceId]),
        readWorkspaceSetting(db, workspaceId, SYNC_SETTING) as Promise<{ reason: string; since: string } | null>,
    ]);
    return { pending: row?.count ?? 0, reason: behind?.reason ?? null, since: behind?.since ?? null };
}

export async function clearPendingCommits(ctx: UseCaseContext): Promise<void> {
    await ctx.db.query('DELETE FROM git_pending_commits WHERE workspace_id = $1', [ctx.workspaceId]);
    await deleteWorkspaceSetting(ctx.db, ctx.workspaceId, SYNC_SETTING);
}

/** the queued commits on top of the environment's branch, pushed; a failure leaves them queued with the reason */
export async function pushPendingCommits(ctx: UseCaseContext, options: GitOptions): Promise<GitSyncView | null> {
    const config = await readGitConfig(ctx.db, ctx.workspaceId);
    if (!config) {
        return null;
    }

    const access = await gitAccess(ctx, config);
    const failure = !access.ok
        ? access.error.message
        : await withWorkspaceClone(options.clonesDir, ctx.workspaceId, access.value, async remote => {
              const rows = await pendingCommits(ctx.db, ctx.workspaceId);
              if (rows.length === 0) {
                  return null;
              }

              try {
                  const refused = await pushOnBranch(remote, config.environment, rows);
                  if (!refused) {
                      await ctx.db.query('DELETE FROM git_pending_commits WHERE workspace_id = $1 AND id <= $2', [
                          ctx.workspaceId,
                          rows[rows.length - 1]!.id,
                      ]);
                  }

                  return refused;
              } catch (e) {
                  if (e instanceof GitError) {
                      return `The repository answered: ${e.message}`;
                  }

                  throw e;
              }
          });

    if (failure) {
        const behind = (await readWorkspaceSetting(ctx.db, ctx.workspaceId, SYNC_SETTING)) as { since: string } | null;
        await writeWorkspaceSetting(
            ctx.db,
            ctx.workspaceId,
            SYNC_SETTING,
            { reason: failure, since: behind?.since ?? new Date().toISOString() },
            ctx.userId,
        );
    } else {
        await deleteWorkspaceSetting(ctx.db, ctx.workspaceId, SYNC_SETTING);
    }

    return gitSyncStatus(ctx.db, ctx.workspaceId);
}

/** null once pushed, or why the branch cannot take them */
async function pushOnBranch(remote: GitRemote, environment: string, rows: PendingRow[]): Promise<string | null> {
    const branches = await remote.branches();
    const topology = await readTopology(remote, environment, branches);
    if (!topology.exists) {
        return `The repository has no ${CONFIG_BRANCH} branch.`;
    }
    if (!topology.environment) {
        return `${environment} is not in the topology.`;
    }
    if (!topology.branchExists) {
        return `The branch ${topology.environment.branch} does not exist yet.`;
    }

    // rebuilt on the branch as it is now, not on what a failed push left in the clone: the branch may have moved since
    const branch = topology.environment.branch;
    const tip = await remote.fetch(branch, branches);
    let head = tip;
    for (const row of rows) {
        head = await remote.commit({
            parent: head,
            changes: row.changes,
            message: row.message,
            author: row.author_name && row.author_email ? { name: row.author_name, email: row.author_email } : undefined,
        });
    }

    if (head !== tip) {
        await remote.push(head!, branch, tip);
    }

    return null;
}
