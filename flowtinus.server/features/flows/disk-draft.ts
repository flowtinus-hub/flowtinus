import { newFlowFile, repoFlowFromYaml, repoFlowToYaml, type FlowFile } from '@flowtinus/core';
import { reconcileFromDisk } from '#features/git/disk-reconcile';
import { readDiskText, writeDisk } from '#features/git/disk-write';
import { localRepoOf } from '#features/git/local-server';
import { committedFlowText, flowsInRepo } from '#features/git/workspace-export';
import { withoutPinned } from '#features/pins/pins';
import { saveBlob, scriptBlobs } from '#features/scripts/script-store';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import type { Flow } from './flow';
import { flowRepoPath, type FlowDraft } from './flow-draft';

/*
 * On a local server a flow's draft is its file on disk, and its revision the hash of the text the editor holds: its
 * base, kept as a blob so that a save made after the disk moved can be merged on it.
 */

async function fallbackText(ctx: UseCaseContext, row: Flow): Promise<string> {
    const [inRepo] = await flowsInRepo(ctx.db, ctx.workspaceId, [row.id]);
    return inRepo ? committedFlowText(row.id, inRepo) : repoFlowToYaml(newFlowFile(row.name, row.id));
}

export async function loadDiskDraft(ctx: UseCaseContext, row: Flow): Promise<FlowDraft> {
    const text = readDiskText(localRepoOf(ctx.git)!, await flowRepoPath(ctx.db, ctx.workspaceId, row));
    const read = text === null ? null : repoFlowFromYaml(text, row.name);
    // a file that does not read (conflict markers) is shown as last applied, and a save on it merges with the disk
    const base = read?.ok ? text! : await fallbackText(ctx, row);
    const shown = read?.ok ? read : repoFlowFromYaml(base, row.name);
    const flow = shown.ok ? shown.value.flow : newFlowFile(row.name, row.id);
    return { flow: withoutPinned({ ...flow, id: row.id, name: row.name }), revision: await saveBlob(ctx.db, ctx.workspaceId, base) };
}

export const changedOnDiskSince = () =>
    fail(
        'conflict',
        'This flow changed on disk since it was opened, and the change cannot be merged with yours: nothing was written. Reload it from disk, or save yours as a new flow.',
    );

export async function saveDiskDraft(
    ctx: UseCaseContext,
    row: Flow,
    flow: FlowFile,
    revision: number | string,
): Promise<UseCaseResult<{ revision: string }>> {
    const base = typeof revision === 'string' ? (await scriptBlobs(ctx.db, ctx.workspaceId, [revision])).get(revision) : undefined;
    if (base === undefined) {
        return changedOnDiskSince();
    }
    const read = repoFlowFromYaml(base, row.name);
    const ours = repoFlowToYaml({ ...flow, id: row.id, name: row.name }, read.ok ? read.value : {});
    const written = await writeDisk(localRepoOf(ctx.git)!, [{ path: await flowRepoPath(ctx.db, ctx.workspaceId, row), text: ours, base }]);
    if (!written.ok) {
        return changedOnDiskSince();
    }

    await ctx.db.query('UPDATE flows SET updated_at = now(), updated_by = $3 WHERE workspace_id = $1 AND id = $2', [
        ctx.workspaceId,
        row.id,
        ctx.userId,
    ]);
    const saved = await saveBlob(ctx.db, ctx.workspaceId, ours);
    await reconcileFromDisk(ctx);
    return success({ revision: saved });
}
