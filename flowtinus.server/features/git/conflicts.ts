import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoEntry, type RepoEntry } from '@flowtinus/core';
import { workspaceHandle } from '#features/folders/project-tree';
import { saveBlob, scriptBlobs } from '#features/scripts/script-store';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { filesAt, forgetWorkBranch, workBranch, type WorkBranch } from './branch-read';
import { lockBranch, refuseReadOnly } from './branch-write';
import { refuseOffEditableBranch } from './current-branch';
import { gitBranch } from './git-config';
import { pendingMerge } from './pending-merge';
import { lockReconcile } from './reconcile';
import { canonical, ENVIRONMENT_BRANCH, idOfFile, workingRows, type WorkingRow } from './working-copy';
import { chosenBy, workingItems, type Item } from './working-copy-changes';
import type { RepoFiles } from './workspace-export';
import { importStructure, issueFields, validateImport } from './workspace-import';

export type Hunk = { mine: string[]; base: string[]; theirs: string[] };

export type Segment = { lines: string[] } | { hunk: Hunk };

export type ConflictCase =
    | { type: 'content'; segments: Segment[]; names?: { mine: string; theirs: string } }
    | { type: 'deleted'; deletedBy: 'mine' | 'theirs'; text: string }
    | { type: 'added'; name: string; mine: string; theirs: string };

export type ConflictView = {
    path: string;
    from?: string;
    kind: RepoEntry['kind'];
    fileId: string | null;
    commit: string;
    revision: number;
    conflict: ConflictCase;
    duplicable: boolean;
};

export type HunkChoice = 'mine' | 'theirs' | 'both' | { edit: string };

export type Resolution = {
    path: string;
    revision: number;
    hunks?: HunkChoice[];
    name?: 'mine' | 'theirs';
    keep?: boolean;
    rename?: string;
};

const MARKER = 32;

export async function mergeSegments(mine: string, base: string, theirs: string): Promise<{ segments: Segment[]; newline: boolean }> {
    const dir = await mkdtemp(join(tmpdir(), 'flowtinus-conflict-'));
    try {
        const files = [join(dir, 'mine'), join(dir, 'base'), join(dir, 'theirs')];
        await Promise.all([mine, base, theirs].map((text, i) => Bun.write(files[i]!, text)));
        const merge = Bun.spawn(
            ['git', 'merge-file', '-p', '--diff3', `--marker-size=${MARKER}`, '-L', 'mine', '-L', 'base', '-L', 'theirs', ...files],
            { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        );
        const [out, err, code] = await Promise.all([new Response(merge.stdout).text(), new Response(merge.stderr).text(), merge.exited]);
        if (code < 0 || code > 127) {
            throw new Error(`git merge-file: ${err}`);
        }
        const lines = out.split('\n');
        if (out.endsWith('\n')) {
            lines.pop();
        }
        const marker = (line: string, c: string) => line.startsWith(c.repeat(MARKER)) && (line.length === MARKER || line[MARKER] === ' ');
        const segments: Segment[] = [];
        let clean: string[] = [];
        let hunk: Hunk | null = null;
        let side: keyof Hunk = 'mine';
        for (const line of lines) {
            if (marker(line, '<')) {
                if (clean.length) {
                    segments.push({ lines: clean });
                }
                clean = [];
                hunk = { mine: [], base: [], theirs: [] };
                side = 'mine';
            } else if (hunk && marker(line, '|')) {
                side = 'base';
            } else if (hunk && marker(line, '=')) {
                side = 'theirs';
            } else if (hunk && marker(line, '>')) {
                segments.push({ hunk });
                hunk = null;
            } else if (hunk) {
                hunk[side].push(line);
            } else {
                clean.push(line);
            }
        }
        if (clean.length) {
            segments.push({ lines: clean });
        }
        return { segments, newline: out.endsWith('\n') || out === '' };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const hunksOf = (segments: Segment[]) => segments.flatMap(s => ('hunk' in s ? [s.hunk] : []));

const TOP_KEY = /^[A-Za-z_][\w-]*:\s*$/;

// a side made of whole top-level blocks ("schedules:" and its items), by key; null when it is not
function topBlocks(lines: string[]): Map<string, string[]> | null {
    if (lines.length === 0 || !TOP_KEY.test(lines[0]!)) {
        return null;
    }
    const blocks = new Map<string, string[]>();
    let current: string[] = [];
    for (const line of lines) {
        if (TOP_KEY.test(line)) {
            if (blocks.has(line.trim())) {
                return null;
            }
            current = [];
            blocks.set(line.trim(), current);
        } else if (/^\S/.test(line)) {
            return null;
        } else {
            current.push(line);
        }
    }
    return blocks;
}

// both sides opened the same list (each added the first schedule, say): one key with the items of both, not the key twice
function bothSides(hunk: Hunk): string[] {
    const mine = topBlocks(hunk.mine);
    const theirs = topBlocks(hunk.theirs);
    if (!mine || !theirs || ![...mine.keys()].some(key => theirs.has(key))) {
        return [...hunk.mine, ...hunk.theirs];
    }
    const keys = [...new Set([...mine.keys(), ...theirs.keys()])];
    return keys.flatMap(key => [key, ...(mine.get(key) ?? []), ...(theirs.get(key) ?? [])]);
}

export function joinSegments(segments: Segment[], choices: HunkChoice[], newline: boolean): string | null {
    const lines: string[] = [];
    let i = 0;
    for (const segment of segments) {
        if ('lines' in segment) {
            lines.push(...segment.lines);
            continue;
        }
        const choice = choices[i++];
        if (choice === undefined) {
            return null;
        }
        if (choice === 'both') {
            lines.push(...bothSides(segment.hunk));
        }
        if (choice === 'mine') {
            lines.push(...segment.hunk.mine);
        }
        if (choice === 'theirs') {
            lines.push(...segment.hunk.theirs);
        }
        if (typeof choice === 'object' && choice.edit !== '') {
            lines.push(...choice.edit.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));
        }
    }
    return lines.length === 0 ? '' : lines.join('\n') + (newline ? '\n' : '');
}

type Situation = {
    item: Item;
    row: WorkingRow;
    was: WorkingRow | undefined;
    commit: string;
    theirsPath: string | null;
    theirs: string | null;
    base: string;
    revision: number;
    conflict: ConflictCase;
    newline: boolean;
};

function theirsAt(files: RepoFiles, row: WorkingRow, was: WorkingRow | undefined): string | null {
    const path = was?.path ?? row.path;
    if (repoEntry(row.path).kind === 'flow' && row.file_id && (was ?? row).base !== null) {
        for (const [at, text] of Object.entries(files)) {
            if (repoEntry(at).kind === 'flow' && idOfFile(at, text) === row.file_id) {
                return at;
            }
        }
        return null;
    }
    return path in files ? path : null;
}

async function marked(ctx: UseCaseContext, branch: WorkBranch | null, commit: string): Promise<RepoFiles> {
    if (branch && commit === branch.tip) {
        return branch.tipFiles;
    }
    const git = await gitBranch(ctx.db, ctx.workspaceId);
    return filesAt(ctx, branch?.branch ?? git?.branch ?? '', commit);
}

const nameOf = (path: string) => {
    const entry = repoEntry(path);
    return 'name' in entry ? entry.name : 'project' in entry ? entry.project : path;
};

async function situationOf(ctx: UseCaseContext, branch: WorkBranch | null, item: Item): Promise<Situation | null> {
    if (!item.conflict) {
        return null;
    }
    const [row, was] = item.rows as [WorkingRow, WorkingRow | undefined];
    const commit = item.conflict;
    const files = await marked(ctx, branch, commit);
    const theirsPath = theirsAt(files, row, was);
    const theirs = theirsPath ? canonical(theirsPath, files[theirsPath]!) : null;
    const baseHash = was?.base ?? row.base;
    const base = baseHash ? ((await scriptBlobs(ctx.db, ctx.workspaceId, [baseHash])).get(baseHash) ?? '') : '';
    const revision = Math.max(...item.rows.map(r => r.revision));
    const mine = row.content ?? '';
    const at = { item, row, was, commit, theirsPath, theirs, base, revision, newline: true };

    if (theirs === null) {
        // they deleted it (a deleted row of mine with nothing at the commit is no conflict: nothing to choose)
        return row.deleted ? null : { ...at, conflict: { type: 'deleted', deletedBy: 'theirs', text: mine } };
    }
    if (row.deleted) {
        return { ...at, conflict: { type: 'deleted', deletedBy: 'mine', text: theirs } };
    }
    if (row.base === null && !was) {
        return { ...at, conflict: { type: 'added', name: nameOf(row.path), mine, theirs } };
    }
    const { segments, newline } = await mergeSegments(mine, base, theirs);
    const renamed = was && theirsPath !== was.path && theirsPath !== row.path;
    return {
        ...at,
        newline,
        conflict: { type: 'content', segments, ...(renamed ? { names: { mine: row.path, theirs: theirsPath! } } : {}) },
    };
}

async function find(ctx: UseCaseContext, branch: WorkBranch | null, path: string) {
    const { items, files } = await workingItems(ctx, branch);
    const [item] = chosenBy(items, [path]);
    const situation = item ? await situationOf(ctx, branch, item) : null;
    return { situation, files };
}

export async function readConflict(ctx: UseCaseContext, path: string): Promise<UseCaseResult<ConflictView>> {
    const branch = await workBranch(ctx);
    const { situation } = await find(ctx, branch, path);
    if (!situation) {
        return fail('not-found', `${path} has no conflict to resolve.`);
    }
    const { item, conflict, commit, revision } = situation;
    return success({
        path: item.path,
        ...(item.from ? { from: item.from } : {}),
        kind: item.kind,
        fileId: item.fileId,
        commit,
        revision,
        conflict,
        duplicable: !branch && item.kind === 'flow' && conflict.type === 'content' && !conflict.names,
    });
}

type Write = { path: string; content: string; deleted: boolean; base: string | null; fileId: string | null };

const renamedPath = (path: string, name: string) => {
    const entry = repoEntry(path);
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    if (entry.kind === 'flow') {
        return `${dir}${name}.flow.yaml`;
    }
    if (entry.kind === 'connection') {
        return `${dir}${name}.yaml`;
    }
    if (entry.kind === 'project') {
        return `${entry.workspace}/projects/${name}/project.yaml`;
    }
    return null;
};

type Outcome = { writes: Write[]; drops: string[]; moves: [string, string][]; tree: Record<string, string | null> };

function outcomeOf(s: Situation, request: Resolution, files: RepoFiles): Outcome | string {
    const { row, was, theirs, theirsPath, conflict } = s;
    const out: Outcome = { writes: [], drops: [], moves: [], tree: {} };
    const write = (path: string, content: string, deleted: boolean, base: string | null) => {
        out.writes.push({ path, content, deleted, base, fileId: row.file_id });
        out.tree[path] = deleted ? null : content;
    };

    if (conflict.type === 'content') {
        const text = joinSegments(conflict.segments, request.hunks ?? [], s.newline);
        if (text === null || (request.hunks ?? []).length !== hunksOf(conflict.segments).length) {
            return 'Choose each conflicting hunk.';
        }
        if (!was) {
            if (theirsPath !== row.path) {
                out.drops.push(row.path);
                out.tree[row.path] = null;
            }
            write(theirsPath!, text, false, theirs);
        } else if (!conflict.names) {
            write(row.path, text, false, null);
            write(was.path, theirs!, true, theirs);
            out.tree[was.path] = null;
        } else if (!request.name) {
            return 'Choose the name to keep.';
        } else {
            out.drops.push(was.path);
            if (request.name === 'mine') {
                write(row.path, text, false, null);
                write(theirsPath!, theirs!, true, theirs);
            } else {
                out.drops.push(row.path);
                out.tree[row.path] = null;
                write(theirsPath!, text, false, theirs);
            }
        }
        return out;
    }

    if (conflict.type === 'deleted') {
        if (request.keep === undefined) {
            return 'Choose to keep it or to delete it.';
        }
        if (conflict.deletedBy === 'theirs') {
            if (was) {
                out.drops.push(was.path);
            }
            write(row.path, conflict.text, !request.keep, null);
        } else {
            if (theirsPath !== row.path) {
                out.drops.push(row.path);
            }
            write(theirsPath!, theirs!, !request.keep, theirs);
        }
        return out;
    }

    const name = request.rename?.trim() ?? '';
    const to = name && !/[/\\]/.test(name) ? renamedPath(row.path, name) : null;
    if (!to || to === row.path) {
        return 'Give yours another name.';
    }
    if (repoEntry(row.path).kind === 'project') {
        const from = row.path.slice(0, -'project.yaml'.length);
        const into = to.slice(0, -'project.yaml'.length);
        if (Object.keys(files).some(p => p.toLowerCase().startsWith(into.toLowerCase()))) {
            return `A project named ${name} is already there.`;
        }
        out.moves.push([from, into]);
    } else {
        if (Object.keys(files).some(p => p.toLowerCase() === to.toLowerCase())) {
            return `${nameOf(to)} is already there.`;
        }
        out.moves.push([row.path, to]);
    }
    return out;
}

const movedRows = (moves: [string, string][], rows: WorkingRow[]): [WorkingRow, string][] =>
    moves.flatMap(([from, to]) =>
        rows
            .filter(r => (from.endsWith('/') ? r.base === null && !r.deleted && r.path.startsWith(from) : r.path === from))
            .map(r => [r, to + r.path.slice(from.length)] as [WorkingRow, string]),
    );

function movedTree(moved: [WorkingRow, string][], theirs: RepoFiles): Record<string, string | null> {
    const tree: Record<string, string | null> = {};
    for (const [row, to] of moved) {
        tree[row.path] = row.path in theirs ? canonical(row.path, theirs[row.path]!) : null;
        tree[to] = row.content ?? '';
    }
    return tree;
}

async function nextRevision(db: Database, workspaceId: string, branch: string, fileId: string | null, path: string): Promise<number> {
    const [row] = await db.query<{ revision: number | null }>(
        `SELECT max(revision) AS revision FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND (path = $3 OR file_id = $4)`,
        [workspaceId, branch, path, fileId],
    );
    return (row?.revision ?? 0) + 1;
}

export async function resolveConflict(ctx: UseCaseContext, request: Resolution): Promise<UseCaseResult<{ path: string }>> {
    const branch = await workBranch(ctx);
    if (branch) {
        await refuseReadOnly(ctx, branch);
    } else {
        await refuseOffEditableBranch(ctx.db, ctx.workspaceId, ctx.userId);
    }
    const name = branch?.branch ?? ENVIRONMENT_BRANCH;
    const result = await ctx.db.transaction(async (db): Promise<UseCaseResult<{ path: string }>> => {
        const at = { ...ctx, db };
        if (branch) {
            await lockBranch(db, ctx.workspaceId, branch.branch);
        } else {
            await lockReconcile(db, ctx.workspaceId);
        }
        const { situation, files } = await find(at, branch, request.path);
        if (!situation) {
            return fail('not-found', `${request.path} has no conflict to resolve.`);
        }
        if (situation.revision !== request.revision) {
            return fail('conflict', `${request.path} changed since the conflict was read: open it again.`);
        }
        const outcome = outcomeOf(situation, request, files);
        if (typeof outcome === 'string') {
            return fail('validation', outcome);
        }

        const rows = situation.item.rows;
        const moved = outcome.moves.length > 0 ? movedRows(outcome.moves, await workingRows(db, ctx.workspaceId, name)) : [];
        const tree = moved.length > 0 ? movedTree(moved, await marked(at, branch, situation.commit)) : outcome.tree;
        const after = { ...files };
        for (const [path, text] of Object.entries(tree)) {
            if (text === null) {
                delete after[path];
            } else {
                after[path] = text;
            }
        }
        const handle = branch?.handle ?? (await workspaceHandle(at));
        const touched = Object.entries(tree).flatMap(([path, text]) => (text === null ? [] : [path]));
        const errors = (await validateImport(db, ctx.workspaceId, handle, after)).errors.filter(e => touched.includes(e.path));
        if (errors.length > 0) {
            return fail('validation', 'The resolved file is not valid: fix it before it can be committed.', issueFields(errors));
        }

        // in an Update's pending merge "theirs" is the environment's file, not this branch's: the resolved file is a change
        // against the branch's own text (mine before resolving), as the files the merge brought cleanly are
        const merging = branch ? await pendingMerge(db, ctx.workspaceId, branch.branch) : null;
        const baseOf = (w: Write) => (merging && w.path === situation.row.path && !w.deleted ? situation.row.content : w.base);
        const where = 'workspace_id = $1 AND branch = $2 AND path = $3';
        for (const path of outcome.drops) {
            await db.query(`DELETE FROM working_copy WHERE ${where}`, [ctx.workspaceId, name, path]);
        }
        for (const w of outcome.writes) {
            const revision = await nextRevision(db, ctx.workspaceId, name, w.fileId, w.path);
            await db.query(
                `INSERT INTO working_copy (workspace_id, branch, path, content, deleted, file_id, base, edited_by, revision)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     ON CONFLICT (workspace_id, branch, path) DO UPDATE SET content = EXCLUDED.content, deleted = EXCLUDED.deleted,
                       file_id = EXCLUDED.file_id, base = EXCLUDED.base, edited_by = EXCLUDED.edited_by, conflict = NULL,
                       revision = EXCLUDED.revision, updated_at = now()`,
                [
                    ctx.workspaceId,
                    name,
                    w.path,
                    w.content,
                    w.deleted,
                    w.fileId,
                    baseOf(w) === null ? null : await saveBlob(db, ctx.workspaceId, baseOf(w)!),
                    ctx.userId,
                    revision,
                ],
            );
        }
        for (const [row, to] of moved) {
            await db.query(
                `UPDATE working_copy SET path = $4, conflict = NULL, edited_by = $5, revision = revision + 1, updated_at = now() WHERE ${where}`,
                [ctx.workspaceId, name, row.path, to, ctx.userId],
            );
            // in a pending merge the branch's tip still holds mine at the path given up: theirs goes there as a change of the branch
            const ours = merging ? branch!.tipFiles[row.path] : undefined;
            const theirs = tree[row.path];
            if (ours !== undefined && typeof theirs === 'string' && theirs !== ours) {
                await db.query(
                    `INSERT INTO working_copy (workspace_id, branch, path, content, deleted, file_id, base, edited_by, revision)
                     VALUES ($1, $2, $3, $4, false, $5, $6, $7, 1)`,
                    [
                        ctx.workspaceId,
                        name,
                        row.path,
                        theirs,
                        idOfFile(row.path, theirs),
                        await saveBlob(db, ctx.workspaceId, ours),
                        ctx.userId,
                    ],
                );
            }
        }
        await db.query(`UPDATE working_copy SET conflict = NULL WHERE ${where.replace('path = $3', 'path = ANY($3::text[])')}`, [
            ctx.workspaceId,
            name,
            rows.map(r => r.path),
        ]);
        if (!branch) {
            await importStructure(at, handle, after, { keep: true });
        }
        const resolved = outcome.writes.find(w => !w.deleted)?.path ?? moved.find(([row]) => row.path === situation.row.path)?.[1];
        return success({ path: resolved ?? request.path });
    });
    forgetWorkBranch(ctx);
    return result;
}
