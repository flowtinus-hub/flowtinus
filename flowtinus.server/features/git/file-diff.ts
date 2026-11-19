import { repoEntry, type RepoEntry } from '@flowtinus/core';
import { scriptBlobs } from '#features/scripts/script-store';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { workBranch } from './branch-read';
import { branchAccess, currentBranchView } from './current-branch';
import { isGitOn } from './git-config';
import { ENVIRONMENT_BRANCH, workingRows } from './working-copy';
import { itemsOf, type ChangeKind } from './working-copy-changes';

export type DiffLine = { kind: ' ' | '-' | '+'; text: string; old?: number; new?: number };

export type DiffHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] };

export type FileDiff = { path: string; from?: string; change: ChangeKind; kind: RepoEntry['kind']; hunks: DiffHunk[] };

const CONTEXT = 3;
// past this many lines added and removed the middle is shown as all removed then all added
const MAX_EDITS = 2000;

const linesOf = (text: string) => {
    if (text === '') {
        return [];
    }
    const lines = text.split('\n');
    return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
};

function shortestEdits(a: string[], b: string[]): DiffLine['kind'][] | null {
    const n = a.length;
    const m = b.length;
    const max = Math.min(n + m, MAX_EDITS);
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice());
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                return backtrack(trace, offset, n, m);
            }
        }
    }
    return null;
}

function backtrack(trace: Int32Array[], offset: number, n: number, m: number): DiffLine['kind'][] {
    const kinds: DiffLine['kind'][] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const v = trace[d]!;
        const k = x - y;
        const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
        const prevX = v[offset + prevK]!;
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            kinds.push(' ');
            x--;
            y--;
        }
        if (d > 0) {
            kinds.push(x === prevX ? '+' : '-');
        }
        x = prevX;
        y = prevY;
    }
    return kinds.reverse();
}

export function diffLines(before: string, after: string): DiffLine[] {
    const a = linesOf(before);
    const b = linesOf(after);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) {
        start++;
    }
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const middleA = a.slice(start, endA);
    const middleB = b.slice(start, endB);
    const kinds = [
        ...a.slice(0, start).map(() => ' ' as const),
        ...(shortestEdits(middleA, middleB) ?? [...middleA.map(() => '-' as const), ...middleB.map(() => '+' as const)]),
        ...a.slice(endA).map(() => ' ' as const),
    ];
    let i = 0;
    let j = 0;
    return kinds.map(kind => {
        if (kind === '+') {
            return { kind, text: b[j++]!, new: j };
        }
        if (kind === '-') {
            return { kind, text: a[i++]!, old: i };
        }
        return { kind, text: a[i++]!, old: i, new: ++j };
    });
}

export function diffHunks(before: string, after: string, context = CONTEXT): DiffHunk[] {
    const lines = diffLines(before, after);
    const ranges: [number, number][] = [];
    lines.forEach((line, i) => {
        if (line.kind === ' ') {
            return;
        }
        const from = Math.max(0, i - context);
        const to = Math.min(lines.length - 1, i + context);
        const last = ranges.at(-1);
        if (last && from <= last[1] + 1) {
            last[1] = to;
        } else {
            ranges.push([from, to]);
        }
    });
    return ranges.map(([from, to]) => {
        const hunk = lines.slice(from, to + 1);
        const olds = hunk.filter(l => l.old !== undefined);
        const news = hunk.filter(l => l.new !== undefined);
        // an empty side starts at 0, as git writes it
        return { oldStart: olds[0]?.old ?? 0, oldLines: olds.length, newStart: news[0]?.new ?? 0, newLines: news.length, lines: hunk };
    });
}

export async function fileDiff(ctx: UseCaseContext, path: string): Promise<UseCaseResult<FileDiff>> {
    const branch = await workBranch(ctx);
    const rows = await workingRows(ctx.db, ctx.workspaceId, branch?.branch ?? ENVIRONMENT_BRANCH);
    const item = itemsOf(rows, ctx.userId).find(i => i.path === path || i.from === path);
    if (!item) {
        return fail('not-found', 'No such change.');
    }
    const [now, was = now] = item.rows;
    const bases = await scriptBlobs(ctx.db, ctx.workspaceId, was!.base ? [was!.base] : []);
    const before = was!.base ? (bases.get(was!.base) ?? '') : '';
    const after = now!.deleted ? '' : (now!.content ?? '');
    return success({
        path: item.path,
        ...(item.from ? { from: item.from } : {}),
        change: item.change,
        kind: repoEntry(item.path).kind,
        hunks: diffHunks(before, after),
    });
}

export class GetFileDiffHandler implements UseCaseHandler<FileDiff> {
    async handle(input: { path?: string }, ctx: UseCaseContext): Promise<UseCaseResult<FileDiff>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }
        if (!input.path) {
            return fail('validation', 'The request has invalid fields.', { path: 'Required' });
        }
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return fail('conflict', 'Git is off in this workspace.');
        }
        const [{ mayChange }, view] = await Promise.all([
            branchAccess(ctx.db, ctx.workspaceId, ctx.userId),
            currentBranchView(ctx.db, ctx.workspaceId, ctx.userId),
        ]);
        if (!mayChange && !view.offersBranch) {
            return fail('not-found', 'No such change.');
        }
        return fileDiff(ctx, input.path);
    }
}
