import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { readGitConfig } from './git-config';
import { lockGitCommits, pushPendingCommits, queueGitCommit } from './git-commits';
import { exportWorkspace, repoChanges, type RepoFiles } from './workspace-export';

/**
 * a change of what the repository holds (a name, a folder, a script, a connection's declaration), in a transaction: what
 * it changed in the exported workspace is queued as one commit in that transaction and pushed after it. `also`: other
 * workspaces it changes (a project moved to another workspace).
 */
export async function mirrorGitChange<T>(
    ctx: UseCaseContext,
    message: string | ((value: T) => string),
    change: (db: Database) => Promise<T>,
    also: string[] = [],
): Promise<T> {
    const queued: string[] = [];
    const value = await ctx.db.transaction(async tx => {
        const mirrored: { workspaceId: string; before: RepoFiles }[] = [];
        for (const workspaceId of [...new Set([ctx.workspaceId, ...also])].sort()) {
            if (await readGitConfig(tx, workspaceId)) {
                await lockGitCommits(tx, workspaceId);
                mirrored.push({ workspaceId, before: await exportWorkspace(tx, workspaceId) });
            }
        }

        const value = await change(tx);
        for (const { workspaceId, before } of mirrored) {
            const changes = repoChanges(before, await exportWorkspace(tx, workspaceId));
            if (Object.keys(changes).length > 0) {
                await queueGitCommit(
                    { ...ctx, db: tx, workspaceId },
                    { message: typeof message === 'string' ? message : message(value), changes: async () => changes },
                );
                queued.push(workspaceId);
            }
        }

        return value;
    });

    if (ctx.git) {
        for (const workspaceId of queued) {
            await pushPendingCommits({ ...ctx, workspaceId }, ctx.git);
        }
    }

    return value;
}
