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
    const shown = read?.ok ? read : repoFlowFromYaml(await fallbackText(ctx, row), row.name);
    const flow = shown.ok ? shown.value.flow : newFlowFile(row.name, row.id);
    const revision = await saveBlob(ctx.db, ctx.workspaceId, text ?? (await fallbackText(ctx, row)));
    return { flow: withoutPinned({ ...flow, id: row.id, name: row.name }), revision };
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
    const opened = typeof revision === 'string' ? (await scriptBlobs(ctx.db, ctx.workspaceId, [revision])).get(revision) : undefined;
    const path = await flowRepoPath(ctx.db, ctx.workspaceId, row);
    if (opened === undefined) {
        return changedOnDiskSince();
    }
    let read = repoFlowFromYaml(opened, row.name);
    let base = opened;
    // a file that did not read (conflict markers) was shown as last applied: the save merges on that, if the file is still the one opened
    if (!read.ok) {
        if (readDiskText(localRepoOf(ctx.git)!, path) !== opened) {
            return changedOnDiskSince();
        }
        base = await fallbackText(ctx, row);
        read = repoFlowFromYaml(base, row.name);
    }
    const ours = repoFlowToYaml({ ...flow, id: row.id, name: row.name }, read.ok ? read.value : {});
    const written = await writeDisk(localRepoOf(ctx.git)!, [{ path, text: ours, base }]);
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
