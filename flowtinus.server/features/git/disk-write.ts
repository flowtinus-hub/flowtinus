import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import { reconcileFromDisk } from './disk-reconcile';
import { localRepoOf } from './local-server';
import { exportTree, type Tree } from './workspace-export';
import { canonical, mergedIsValid, mergeText } from './working-copy';

/** text null: the file goes; base: the text the writer started from (null: a new file); was: where it was read from */
export type DiskChange = { path: string; text: string | null; base: string | null; was?: string };

export function readDiskText(root: string, path: string): string | null {
    try {
        return readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
    } catch {
        return null;
    }
}

const sameText = (path: string, a: string, b: string) => a === b || canonical(path, a) === canonical(path, b);

async function textToWrite(root: string, change: DiskChange): Promise<{ text: string | null } | null> {
    const { path, text, base, was = path } = change;
    const theirs = readDiskText(root, was);
    const taken = was !== path ? readDiskText(root, path) : null;
    if (taken !== null && (text === null || !sameText(path, taken, text))) {
        return null;
    }
    if (theirs === null ? base === null : base !== null && sameText(was, theirs, base)) {
        return { text };
    }
    if (text === null || base === null || theirs === null) {
        return theirs !== null && text !== null && sameText(path, theirs, text) ? { text } : null;
    }
    const merged = await mergeText(canonical(path, text), canonical(was, base), canonical(was, theirs));
    return merged !== null && mergedIsValid(path, merged) ? { text: merged } : null;
}

function prune(root: string, path: string): void {
    for (let dir = dirname(path); dir !== '.' && dir !== ''; dir = dirname(dir)) {
        const at = join(root, dir);
        if (!existsSync(at) || readdirSync(at).length > 0) {
            return;
        }
        rmdirSync(at);
    }
}

export async function writeDisk(
    root: string,
    changes: DiskChange[],
): Promise<{ ok: true; written: Record<string, string> } | { ok: false; conflicts: string[] }> {
    const results = await Promise.all(changes.map(async change => ({ change, result: await textToWrite(root, change) })));
    const conflicts = results.filter(r => r.result === null).map(r => r.change.was ?? r.change.path);
    if (conflicts.length > 0) {
        return { ok: false, conflicts };
    }

    // removals first: a rename only in case is the same file on a case-insensitive disk
    for (const { change, result } of results) {
        const gone = result!.text === null ? change.path : change.was !== undefined && change.was !== change.path ? change.was : null;
        if (gone) {
            rmSync(join(root, gone), { force: true });
            prune(root, gone);
        }
    }
    const written: Record<string, string> = {};
    for (const { change, result } of results) {
        if (result!.text !== null) {
            mkdirSync(dirname(join(root, change.path)), { recursive: true });
            writeFileSync(join(root, change.path), result!.text);
            written[change.path] = result!.text;
        }
    }
    return { ok: true, written };
}

function treeChanges(before: Tree, after: Tree): DiskChange[] {
    const wasOf = new Map(Object.entries(before.ids).map(([path, id]) => [id, path]));
    const changes: DiskChange[] = [];
    const kept = new Set<string>();
    for (const [path, text] of Object.entries(after.files)) {
        const id = after.ids[path];
        const was = (id && wasOf.get(id)) || path;
        kept.add(was);
        if (before.files[was] !== text || was !== path) {
            changes.push({ path, text, base: before.files[was] ?? null, ...(was !== path ? { was } : {}) });
        }
    }
    for (const [path, base] of Object.entries(before.files)) {
        if (!kept.has(path) && !(path in after.files)) {
            changes.push({ path, text: null, base });
        }
    }
    return changes;
}

export const changedOnDisk = (paths: string[]) =>
    `${paths.join(', ')} changed on disk since, and the change cannot be merged with this one: nothing was written.`;

export async function changeOnDisk<T>(
    ctx: UseCaseContext,
    root: string,
    workspaceIds: string[],
    work: (db: Database) => Promise<T>,
): Promise<T> {
    const value = await ctx.db.transaction(async tx => {
        const before = [];
        for (const workspaceId of workspaceIds) {
            before.push(await exportTree(tx, workspaceId));
        }
        const value = await work(tx);
        const changes: DiskChange[] = [];
        for (const [i, workspaceId] of workspaceIds.entries()) {
            changes.push(...treeChanges(before[i]!, await exportTree(tx, workspaceId)));
        }
        await tx.query('DELETE FROM working_copy WHERE workspace_id = ANY($1::uuid[])', [workspaceIds]);
        const written = await writeDisk(root, changes);
        if (!written.ok) {
            throw new UseCaseFailure('conflict', changedOnDisk(written.conflicts));
        }
        return value;
    });
    for (const workspaceId of workspaceIds) {
        await reconcileFromDisk({ ...ctx, workspaceId });
    }
    return value;
}

export function inWorkingCopy<T>(ctx: UseCaseContext, work: (db: Database) => Promise<T>): Promise<T> {
    const root = localRepoOf(ctx.git);
    return root ? changeOnDisk(ctx, root, [ctx.workspaceId], work) : ctx.db.transaction(work);
}
