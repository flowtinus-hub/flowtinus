import type { Database } from '#shared/database/database';

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
