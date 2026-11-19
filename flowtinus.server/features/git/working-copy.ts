import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionFromYaml, projectFromYaml, repoEntry, repoFlowFromYaml, repoFlowToYaml } from '@flowtinus/core';
import { saveBlob, scriptBlobs } from '#features/scripts/script-store';
import type { Database } from '#shared/database/database';
import type { RepoFiles, Tree } from './workspace-export';

/** the environment's branch, whichever branch the topology gives it: its working copy survives a move to another one */
export const ENVIRONMENT_BRANCH = '';

export type WorkingRow = {
    path: string;
    content: string | null;
    deleted: boolean;
    file_id: string | null;
    base: string | null;
    edited_by: string | null;
    conflict: string | null;
    revision: number;
    updated_at: Date;
};

export const scriptFileId = (projectId: string, path: string) => `${projectId}/${path}`;

export const textHash = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');

export const isChange = (row: Pick<WorkingRow, 'deleted' | 'base' | 'content'>) =>
    row.deleted ? row.base !== null : row.base === null || textHash(row.content ?? '') !== row.base;

export const workingRows = (db: Database, workspaceId: string, branch = ENVIRONMENT_BRANCH) =>
    db.query<WorkingRow>(
        `SELECT path, content, deleted, file_id, base, edited_by, conflict, revision, updated_at FROM working_copy
       WHERE workspace_id = $1 AND branch = $2 ORDER BY path`,
        [workspaceId, branch],
    );

export function bestRows(rows: WorkingRow[]): Map<string, WorkingRow> {
    const best = new Map<string, WorkingRow>();
    for (const row of rows) {
        if (!row.file_id) {
            continue;
        }
        const was = best.get(row.file_id);
        if (!was || (was.deleted && !row.deleted) || (was.deleted === row.deleted && row.updated_at > was.updated_at)) {
            best.set(row.file_id, row);
        }
    }
    return best;
}

export async function fileRow(db: Database, workspaceId: string, fileId: string, branch = ENVIRONMENT_BRANCH): Promise<WorkingRow | null> {
    const [row] = await db.query<WorkingRow>(
        `SELECT path, content, deleted, file_id, base, edited_by, conflict, revision, updated_at FROM working_copy
       WHERE workspace_id = $1 AND branch = $2 AND file_id = $3 ORDER BY deleted, updated_at DESC LIMIT 1`,
        [workspaceId, branch, fileId],
    );
    return row ?? null;
}

const rowAt = async (db: Database, workspaceId: string, path: string, branch: string) =>
    (
        await db.query<WorkingRow>(
            `SELECT path, content, deleted, file_id, base, edited_by, conflict, revision, updated_at FROM working_copy
         WHERE workspace_id = $1 AND branch = $2 AND path = $3`,
            [workspaceId, branch, path],
        )
    )[0] ?? null;

async function carriedRevision(db: Database, workspaceId: string, fileId: string | null, branch: string): Promise<number> {
    if (!fileId) {
        return 0;
    }
    const [row] = await db.query<{ revision: number | null }>(
        'SELECT max(revision) AS revision FROM working_copy WHERE workspace_id = $1 AND branch = $2 AND file_id = $3',
        [workspaceId, branch, fileId],
    );
    return row?.revision ?? 0;
}

type Written = { path: string; content: string; fileId: string | null; userId: string | null; revision?: number; committed?: string };

export async function writeFile(db: Database, workspaceId: string, file: Written, branch = ENVIRONMENT_BRANCH): Promise<number> {
    const row = await rowAt(db, workspaceId, file.path, branch);
    if (row) {
        const revision = file.revision ?? row.revision + 1;
        await db.query(
            `UPDATE working_copy SET content = $4, deleted = false, file_id = $5, edited_by = $6, revision = $7, updated_at = now()
         WHERE workspace_id = $1 AND branch = $2 AND path = $3`,
            [workspaceId, branch, file.path, file.content, file.fileId, file.userId, revision],
        );
        return revision;
    }

    const base = file.committed === undefined ? null : await saveBlob(db, workspaceId, file.committed);
    const revision = file.revision ?? (await carriedRevision(db, workspaceId, file.fileId, branch)) + 1;
    await db.query(
        `INSERT INTO working_copy (workspace_id, branch, path, content, file_id, base, edited_by, revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [workspaceId, branch, file.path, file.content, file.fileId, base, file.userId, revision],
    );
    return revision;
}

export async function removeFile(
    db: Database,
    workspaceId: string,
    file: { path: string; fileId: string | null; userId: string | null; last?: string; committed?: string },
    branch = ENVIRONMENT_BRANCH,
): Promise<void> {
    const row = await rowAt(db, workspaceId, file.path, branch);
    if (row) {
        if (!row.deleted) {
            await db.query(
                `UPDATE working_copy SET deleted = true, edited_by = $4, updated_at = now() WHERE workspace_id = $1 AND branch = $2 AND path = $3`,
                [workspaceId, branch, file.path, file.userId],
            );
        }
        return;
    }
    if (file.committed === undefined) {
        return;
    }
    const base = await saveBlob(db, workspaceId, file.committed);
    await db.query(
        `INSERT INTO working_copy (workspace_id, branch, path, content, deleted, file_id, base, edited_by, revision)
       VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8)`,
        [
            workspaceId,
            branch,
            file.path,
            file.last ?? file.committed,
            file.fileId,
            base,
            file.userId,
            await carriedRevision(db, workspaceId, file.fileId, branch),
        ],
    );
}

export async function recordChanges(
    db: Database,
    workspaceId: string,
    before: Tree,
    after: Tree,
    userId: string | null,
    branch = ENVIRONMENT_BRANCH,
): Promise<void> {
    const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
    for (const path of [...paths].sort()) {
        const was = before.files[path];
        const now = after.files[path];
        if (was === now) {
            continue;
        }
        const fileId = after.ids[path] ?? before.ids[path] ?? null;
        if (now === undefined) {
            await removeFile(db, workspaceId, { path, fileId, userId, committed: was, last: was }, branch);
            continue;
        }
        const row = await rowAt(db, workspaceId, path, branch);
        if (row && !row.deleted && row.content === now) {
            continue;
        }
        // a file moved keeps the revision its editor read
        await writeFile(
            db,
            workspaceId,
            {
                path,
                content: now,
                fileId,
                userId,
                ...(row ? {} : { revision: await carriedRevision(db, workspaceId, fileId, branch) }),
                ...(row || was === undefined ? {} : { committed: was }),
            },
            branch,
        );
    }
}

/** the text a file is compared and merged on: a flow's as the app writes it, so that a change is the same lines on both sides */
export function canonical(path: string, text: string): string {
    const entry = repoEntry(path);
    if (entry.kind !== 'flow') {
        return text;
    }
    const read = repoFlowFromYaml(text, entry.name);
    return read.ok ? repoFlowToYaml(read.value.flow, { deployed: read.value.deployed }) : text;
}

export function idOfFile(path: string, text: string): string | null {
    const entry = repoEntry(path);
    const read =
        entry.kind === 'flow'
            ? repoFlowFromYaml(text, entry.name)
            : entry.kind === 'project'
              ? projectFromYaml(text)
              : entry.kind === 'connection'
                ? connectionFromYaml(text)
                : null;
    if (!read?.ok) {
        return null;
    }
    const value = read.value as { id?: string; flow?: { id?: string } };
    return value.flow?.id ?? value.id ?? null;
}

export async function mergeText(ours: string, base: string, theirs: string): Promise<string | null> {
    const dir = await mkdtemp(join(tmpdir(), 'flowtinus-merge-'));
    try {
        const files = [join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')];
        await Promise.all([ours, base, theirs].map((text, i) => Bun.write(files[i]!, text)));
        const merge = Bun.spawn(['git', 'merge-file', '-p', ...files], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
        const [out, code] = await Promise.all([new Response(merge.stdout).text(), merge.exited]);
        return code === 0 ? out : null;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const mergedIsValid = (path: string, text: string) => {
    const entry = repoEntry(path);
    return entry.kind !== 'flow' || repoFlowFromYaml(text, entry.name).ok;
};

export type RenamedDraft = { id: string; from: string; to: string };

export async function followGit(
    db: Database,
    workspaceId: string,
    tip: RepoFiles,
    commit: string,
    branch = ENVIRONMENT_BRANCH,
): Promise<RenamedDraft[]> {
    const rows = await workingRows(db, workspaceId, branch);
    const flowPaths = new Map<string, string>();
    for (const [path, text] of Object.entries(tip)) {
        if (repoEntry(path).kind === 'flow') {
            const id = idOfFile(path, text);
            if (id) {
                flowPaths.set(id, path);
            }
        }
    }
    const taken = new Set([...Object.keys(tip), ...rows.filter(r => !r.deleted).map(r => r.path)].map(p => p.toLowerCase()));
    const bases = await scriptBlobs(
        db,
        workspaceId,
        rows.flatMap(r => (r.base ? [r.base] : [])),
    );
    const lowerPaths = new Map(Object.keys(tip).map(path => [path.toLowerCase(), path]));
    const where = 'workspace_id = $1 AND branch = $2 AND path = $3';
    const at = (row: WorkingRow) => [workspaceId, branch, row.path];
    const mark = (row: WorkingRow) => db.query(`UPDATE working_copy SET conflict = $4 WHERE ${where}`, [...at(row), commit]);
    const renamed: RenamedDraft[] = [];

    for (const row of rows) {
        const kind = repoEntry(row.path).kind;
        const movedTo = kind === 'flow' && row.file_id ? flowPaths.get(row.file_id) : undefined;
        // a new file meets git's at its path whatever the case: a disk that ignores case holds one
        const arrivedPath = movedTo ?? (row.base === null ? (lowerPaths.get(row.path.toLowerCase()) ?? row.path) : row.path);
        const arrived = arrivedPath in tip ? canonical(arrivedPath, tip[arrivedPath]!) : undefined;
        const sameFile =
            arrived !== undefined &&
            (kind === 'flow' || kind === 'project' || kind === 'connection' ? idOfFile(arrivedPath, arrived) === row.file_id : true);

        if (row.base === null) {
            if (arrived === undefined || arrivedPath.toLowerCase() !== row.path.toLowerCase()) {
                continue;
            }
            if (row.deleted) {
                if (sameFile) {
                    await db.query(`UPDATE working_copy SET base = $4 WHERE ${where}`, [
                        ...at(row),
                        await saveBlob(db, workspaceId, arrived),
                    ]);
                } else {
                    await db.query(`DELETE FROM working_copy WHERE ${where}`, at(row));
                }
            } else if (sameFile) {
                await db.query(`UPDATE working_copy SET base = $4, conflict = NULL WHERE ${where}`, [
                    ...at(row),
                    await saveBlob(db, workspaceId, arrived),
                ]);
            } else if (kind === 'flow') {
                renamed.push(await renameDraft(db, workspaceId, row, taken, branch));
            } else {
                await mark(row);
            }
            continue;
        }

        if (row.deleted && movedTo && movedTo !== row.path) {
            const renamedHere = rows.find(r => r !== row && !r.deleted && r.base === null && r.file_id === row.file_id);
            if (renamedHere && renamedHere.path.toLowerCase() !== movedTo.toLowerCase()) {
                await mark(row);
                await mark(renamedHere);
                continue;
            }
        }
        const move = movedTo && movedTo !== row.path && !row.deleted ? movedTo : null;
        if (arrived !== undefined && textHash(arrived) === row.base) {
            if (move) {
                await db.query(`UPDATE working_copy SET path = $4 WHERE ${where}`, [...at(row), move]);
            }
            continue;
        }
        if (row.conflict) {
            await mark(row);
            continue;
        }
        if (row.deleted) {
            const renamedTo = row.file_id
                ? rows.find(r => r !== row && !r.deleted && r.base === null && r.file_id === row.file_id)
                : undefined;
            const base = bases.get(row.base);
            if (arrived === undefined) {
                await db.query(`DELETE FROM working_copy WHERE ${where}`, at(row));
            } else if (renamedTo && base !== undefined) {
                const ours = renamedTo.content ?? '';
                const merged = textHash(ours) === row.base ? arrived : await mergeText(ours, base, arrived);
                if (merged === null || !mergedIsValid(renamedTo.path, merged)) {
                    await mark(row);
                    await mark(renamedTo);
                } else {
                    await db.query(`UPDATE working_copy SET base = $4 WHERE ${where}`, [
                        ...at(row),
                        await saveBlob(db, workspaceId, arrived),
                    ]);
                    await db.query(`UPDATE working_copy SET content = $4, revision = revision + 1, updated_at = now() WHERE ${where}`, [
                        ...at(renamedTo),
                        merged,
                    ]);
                }
            } else {
                await mark(row);
            }
            continue;
        }
        if (arrived === undefined) {
            if (textHash(row.content ?? '') === row.base) {
                await db.query(`DELETE FROM working_copy WHERE ${where}`, at(row));
            } else if (kind === 'flow' && branch === ENVIRONMENT_BRANCH) {
                // a flow git deleted while it has a draft here goes to the archive with its draft (a work branch has no archive: marked)
                await db.query(`UPDATE working_copy SET deleted = true, base = NULL, conflict = NULL WHERE ${where}`, at(row));
            } else {
                await mark(row);
            }
            continue;
        }

        const ours = row.content ?? '';
        const base = bases.get(row.base);
        const merged =
            textHash(ours) === row.base
                ? arrived
                : ours === arrived
                  ? ours
                  : base === undefined
                    ? null
                    : await mergeText(ours, base, arrived);
        if (merged === null || !mergedIsValid(arrivedPath, merged)) {
            await mark(row);
            continue;
        }
        await db.query(
            `UPDATE working_copy SET path = $4, content = $5, base = $6, conflict = NULL, revision = revision + $7, updated_at = now() WHERE ${where}`,
            [...at(row), arrivedPath, merged, await saveBlob(db, workspaceId, arrived), merged === ours ? 0 : 1],
        );
    }
    return renamed;
}

async function renameDraft(db: Database, workspaceId: string, row: WorkingRow, taken: Set<string>, branch: string): Promise<RenamedDraft> {
    const entry = repoEntry(row.path);
    const from = entry.kind === 'flow' ? entry.name : '';
    const dir = row.path.slice(0, row.path.length - `${from}.flow.yaml`.length);
    let name = `${from} (draft)`;
    for (let n = 2; taken.has(`${dir}${name}.flow.yaml`.toLowerCase()); n++) {
        name = `${from} (draft ${n})`;
    }
    const path = `${dir}${name}.flow.yaml`;
    taken.add(path.toLowerCase());
    await db.query('UPDATE working_copy SET path = $4 WHERE workspace_id = $1 AND branch = $2 AND path = $3', [
        workspaceId,
        branch,
        row.path,
        path,
    ]);
    if (branch === ENVIRONMENT_BRANCH) {
        await db.query('UPDATE flows SET name = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2', [
            workspaceId,
            row.file_id,
            name,
        ]);
    }
    return { id: row.file_id!, from, to: name };
}

export async function overlay(db: Database, workspaceId: string, tip: RepoFiles, branch = ENVIRONMENT_BRANCH): Promise<RepoFiles> {
    return overlayRows(tip, await workingRows(db, workspaceId, branch));
}

export function overlayRows(tip: RepoFiles, rows: WorkingRow[]): RepoFiles {
    const files = { ...tip };
    for (const row of rows) {
        if (row.deleted) {
            if (row.base !== null) {
                delete files[row.path];
            }
        } else {
            files[row.path] = row.content ?? '';
        }
    }
    return files;
}
