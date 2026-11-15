export type RowWriteMode = 'insert' | 'upsert' | 'update' | 'delete';
export type RowWrite = {
    connection: string;
    table: string;
    columns: string[];
    rows: unknown[][];
    mode: RowWriteMode;
    /** upsert and update: the columns that find the row (a delete matches on all of `columns`) */
    match?: string[];
    /** update only: additional expected values for each row, independent of the values being set */
    conditions?: { columns: string[]; rows: unknown[][] };
    timeoutMs: number;
    signal: AbortSignal;
};

/**
 * what happened to each row, in order: superseded = a later row of the same batch had the same match values (upsert);
 * notFound = no row of the table matched (update, delete)
 */
export type RowWriteResult = 'inserted' | 'updated' | 'superseded' | 'deleted' | 'notFound';

export type RowWriteAnswer = { results: RowWriteResult[]; rows?: number[] };

/**
 * A database driver that writes: the whole batch in one transaction (all of it, or none: a failure rejects). Lives in
 * the runner; the core only receives the function.
 */
export type WriteRows = (write: RowWrite) => Promise<RowWriteAnswer>;
