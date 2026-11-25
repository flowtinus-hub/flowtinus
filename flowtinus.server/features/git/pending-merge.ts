import { saveBlob } from '#features/scripts/script-store';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { branchIds } from './branch-write';
import type { GitRemote } from './git-remote';
import type { RepoFiles } from './workspace-export';
import { readBranchWorkspace } from './workspace-import';

export type PendingMerge = {
    branch: string;
    ours: string;
    theirs: string;
    source: string;
    paths: string[];
    conflicts: string[];
    mergedBy: string | null;
    createdAt: Date;
};

export type PendingMergeView = { from: string; theirs: string; ours: string; conflicts: string[] };

export const pendingMergeView = (merge: PendingMerge): PendingMergeView => ({
    from: merge.source,
    theirs: merge.theirs,
    ours: merge.ours,
    conflicts: merge.conflicts,
});

export async function pendingMerge(db: Database, workspaceId: string, branch: string): Promise<PendingMerge | null> {
    const [row] = await db.query<{
        ours: string;
        theirs: string;
        source: string;
        paths: string[];
        conflicts: string[];
        merged_by: string | null;
        created_at: Date;
    }>('SELECT ours, theirs, source, paths, conflicts, merged_by, created_at FROM pending_merges WHERE workspace_id = $1 AND branch = $2', [
        workspaceId,
        branch,
    ]);
    return row
        ? {
              branch,
              ours: row.ours,
              theirs: row.theirs,
              source: row.source,
              paths: row.paths,
              conflicts: row.conflicts,
              mergedBy: row.merged_by,
              createdAt: new Date(row.created_at),
          }
        : null;
}

export const dropPendingMerge = (db: Database, workspaceId: string, branch: string) =>
    db.query('DELETE FROM pending_merges WHERE workspace_id = $1 AND branch = $2', [workspaceId, branch]);

export const pendingMergeRefusal = (merge: PendingMerge) =>
    `A merge of ${merge.source} is pending on ${merge.branch}: Commit it whole, or Discard all to abort it.`;

export const scopeOf = (handle: string) => [handle, '.gitattributes'];

export const inScope = (path: string, handle: string) => path.startsWith(`${handle}/`) || path === '.gitattributes';

// marked as a moved branch marks a file: row.base, row.content and the file at row.conflict are the three texts
export async function holdMerge(
    db: Database,
    ctx: UseCaseContext,
    remote: GitRemote,
    merge: {
        branch: string;
        handle: string;
        ours: string;
        theirs: string;
        base: string;
        environment: string;
        tipFiles: RepoFiles;
        tree: string;
        conflicts: string[];
    },
): Promise<PendingMerge> {
    const scope = scopeOf(merge.handle);
    const baseFiles = await readBranchWorkspace(remote, merge.base, merge.handle);
    const theirsFiles = await readBranchWorkspace(remote, merge.theirs, merge.handle);
    const mergedFiles = await remote.files(merge.tree, scope);
    // a conflicted file's merged text has markers and reads as nothing: its id comes from either side
    const ids = {
        ...branchIds(theirsFiles, merge.handle),
        ...branchIds(merge.tipFiles, merge.handle),
        ...branchIds(mergedFiles, merge.handle),
    };
    const paths = [...new Set([...(await remote.changedPaths(merge.ours, merge.tree, scope)), ...merge.conflicts])].sort();

    const written: string[] = [];
    const conflicts: string[] = [];
    for (const path of paths) {
        const ours = merge.tipFiles[path];
        let row: { content: string; deleted: boolean; base: string | undefined; conflict: string | null };
        if (merge.conflicts.includes(path)) {
            const base = baseFiles[path];
            const theirs = theirsFiles[path];
            if (ours === undefined && base === undefined && theirs === undefined) {
                continue;
            }
            row = { content: ours ?? theirs ?? base!, deleted: ours === undefined && base !== undefined, base, conflict: merge.theirs };
        } else {
            const merged = mergedFiles[path];
            if (merged === undefined && ours === undefined) {
                continue;
            }
            row = { content: merged ?? ours!, deleted: merged === undefined, base: ours, conflict: null };
        }
        await db.query(
            `INSERT INTO working_copy (workspace_id, branch, path, content, deleted, file_id, base, edited_by, conflict, revision)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
           ON CONFLICT (workspace_id, branch, path) DO UPDATE SET content = EXCLUDED.content, deleted = EXCLUDED.deleted,
             file_id = EXCLUDED.file_id, base = EXCLUDED.base, edited_by = EXCLUDED.edited_by, conflict = EXCLUDED.conflict,
             revision = working_copy.revision + 1, updated_at = now()`,
            [
                ctx.workspaceId,
                merge.branch,
                path,
                row.content,
                row.deleted,
                ids[path] ?? null,
                row.base === undefined ? null : await saveBlob(db, ctx.workspaceId, row.base),
                ctx.userId,
                row.conflict,
            ],
        );
        written.push(path);
        if (row.conflict) {
            conflicts.push(path);
        }
    }
    await db.query(
        `INSERT INTO pending_merges (workspace_id, branch, ours, theirs, source, paths, conflicts, merged_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ctx.workspaceId, merge.branch, merge.ours, merge.theirs, merge.environment, written, conflicts, ctx.userId],
    );
    return {
        branch: merge.branch,
        ours: merge.ours,
        theirs: merge.theirs,
        source: merge.environment,
        paths: written,
        conflicts,
        mergedBy: ctx.userId,
        createdAt: new Date(),
    };
}
