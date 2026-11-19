import type { Database } from '#shared/database/database';

/**
 * A pending merge: an Update whose merge could not be pushed at once (conflicts, or a merged tree that does not
 * validate). The files it brought are in the branch's working copy (`paths`); those that conflicted carry the mark of
 * `theirs`, as a moved branch's do. Commit takes it whole as a merge commit (`ours`, `theirs`); Discard all aborts it.
 */
export type PendingMerge = {
    branch: string;
    /** the branch's tip it was made on: the first parent */
    ours: string;
    /** the environment's branch tip merged in: the second parent */
    theirs: string;
    /** the environment's branch, by name */
    source: string;
    paths: string[];
    conflicts: string[];
    mergedBy: string | null;
    createdAt: Date;
};

/** what the editor is told of a pending merge */
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
