import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { isGitOn } from './git-config';
import { lockGitCommits, pushPendingCommits, queueGitCommit } from './git-commits';
import { exportWorkspace, repoChanges, type RepoFiles } from './workspace-export';

export async function mirrorGitChange<T>(
    ctx: UseCaseContext,
    message: (value: NoInfer<T>) => string,
    change: (db: Database) => Promise<T>,
    also: string[] = [],
): Promise<T> {
    const queued: string[] = [];
    const value = await ctx.db.transaction(async tx => {
        const mirrored: { workspaceId: string; before: RepoFiles }[] = [];
        for (const workspaceId of [...new Set([ctx.workspaceId, ...also])].sort()) {
            if (await isGitOn(tx, workspaceId)) {
                await lockGitCommits(tx, workspaceId);
                mirrored.push({ workspaceId, before: await exportWorkspace(tx, workspaceId) });
            }
        }

        const value = await change(tx);
        for (const { workspaceId, before } of mirrored) {
            const changes = repoChanges(before, await exportWorkspace(tx, workspaceId));
            if (Object.keys(changes).length > 0) {
                await queueGitCommit({ ...ctx, db: tx, workspaceId }, { message: message(value), changes: async () => changes });
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
