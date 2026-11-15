import type { RowWriteResult, WriteRows } from '@flowtinus/core';
import type { Transaction } from 'mssql';
import { sqlServerPool } from './sqlserver-driver';

/*
 * SQL Server Insert, Update and Delete's driver, in the worker (mssql): the batch in one transaction (all of it, or none), every
 * value a parameter (@p0, @p1...), each statement with the component's timeout; Stop rolls the transaction back. The
 * table and column names come checked by the core (letters, digits, _ and $) and go into the text in brackets.
 *
 * Insert: INSERT ... VALUES (...), (...) in groups under SQL Server's limits (1000 rows per VALUES, 2100 parameters per
 * request). Update: one UPDATE per row, and how many rows each one changed comes back (0: not found). Delete: one
 * DELETE per row, WHERE every column = its value, and how many rows each one deleted comes back (0: not found; a later
 * row of the batch with the same values finds nothing). The SQL Server Query stays read-only.
 */

/** parameters per request (SQL Server takes at most 2100) and rows per VALUES (at most 1000) */
const MAX_PARAMETERS = 2000;
const MAX_VALUES_ROWS = 1000;

const bracket = (name: string) =>
    name
        .split('.')
        .map(part => `[${part}]`)
        .join('.');

type Sql = typeof import('mssql');

async function insertRows(sql: Sql, transaction: Transaction, table: string, columns: string[], rows: unknown[][], timeoutMs: number) {
    const size = Math.max(1, Math.min(MAX_VALUES_ROWS, Math.floor(MAX_PARAMETERS / Math.max(1, columns.length))));
    const list = columns.map(bracket).join(', ');
    for (let start = 0; start < rows.length; start += size) {
        const group = rows.slice(start, start + size);
        const request = new sql.Request(transaction);
        (request as unknown as { timeout: number }).timeout = timeoutMs;
        let n = 0;
        const values = group.map(
            row =>
                `(${row
                    .map(value => {
                        const name = `p${n++}`;
                        request.input(name, value ?? null);
                        return `@${name}`;
                    })
                    .join(', ')})`,
        );
        await request.query(`INSERT INTO ${bracket(table)} (${list}) VALUES ${values.join(', ')}`);
    }
    return rows.map((): RowWriteResult => 'inserted');
}

async function updateRows(
    sql: Sql,
    transaction: Transaction,
    table: string,
    columns: string[],
    rows: unknown[][],
    match: string[],
    conditions: { columns: string[]; rows: unknown[][] } | undefined,
    timeoutMs: number,
    signal: AbortSignal,
) {
    const isMatch = (column: string) => match.some(m => m.toLowerCase() === column.toLowerCase());
    const set = columns.flatMap((c, i) => (isMatch(c) ? [] : [`${bracket(c)} = @p${i}`]));
    const where = columns.flatMap((c, i) => (isMatch(c) ? [`${bracket(c)} = @p${i}`] : []));
    if (conditions) {
        if (conditions.rows.length !== rows.length || conditions.rows.some(row => row.length !== conditions.columns.length)) {
            throw new Error('Expected values must match the condition columns and row count.');
        }
        if (columns.length + conditions.columns.length > MAX_PARAMETERS) {
            throw new Error('Too many update and condition parameters.');
        }
        conditions.columns.forEach((column, i) => {
            where.push(`(${bracket(column)} = @c${i} OR (${bracket(column)} IS NULL AND @c${i} IS NULL))`);
        });
    }
    const text = `UPDATE ${bracket(table)} SET ${set.join(', ')} WHERE ${where.join(' AND ')}`;
    const results: RowWriteResult[] = [];
    const changed: number[] = [];
    for (const [index, row] of rows.entries()) {
        if (signal.aborted) {
            throw new Error('The run was stopped: nothing of the batch was written.');
        }
        const request = new sql.Request(transaction);
        (request as unknown as { timeout: number }).timeout = timeoutMs;
        row.forEach((value, i) => request.input(`p${i}`, value ?? null));
        conditions?.rows[index]!.forEach((value, i) => request.input(`c${i}`, value ?? null));
        const n = (await request.query(text)).rowsAffected[0] ?? 0;
        results.push(n > 0 ? 'updated' : 'notFound');
        changed.push(n);
    }
    return { results, rows: changed };
}

async function deleteRows(
    sql: Sql,
    transaction: Transaction,
    table: string,
    columns: string[],
    rows: unknown[][],
    timeoutMs: number,
    signal: AbortSignal,
) {
    if (columns.length === 0) {
        throw new Error('A delete needs at least one Match on column.');
    }
    const text = `DELETE FROM ${bracket(table)} WHERE ${columns.map((c, i) => `${bracket(c)} = @p${i}`).join(' AND ')}`;
    const results: RowWriteResult[] = [];
    const deleted: number[] = [];
    for (const row of rows) {
        if (signal.aborted) {
            throw new Error('The run was stopped: nothing of the batch was written.');
        }
        const request = new sql.Request(transaction);
        (request as unknown as { timeout: number }).timeout = timeoutMs;
        row.forEach((value, i) => request.input(`p${i}`, value ?? null));
        const n = (await request.query(text)).rowsAffected[0] ?? 0;
        results.push(n > 0 ? 'deleted' : 'notFound');
        deleted.push(n);
    }
    return { results, rows: deleted };
}

export const writeSqlServer: WriteRows = async ({ connection, table, columns, rows, mode, match, conditions, timeoutMs, signal }) => {
    if (mode === 'upsert' || (mode === 'update' && !match?.length)) {
        throw new Error(
            'SQL Server takes inserts (SQL Server Insert), updates by their Match on columns (SQL Server Update) and deletes (SQL Server Delete).',
        );
    }
    if (signal.aborted) {
        throw new Error('The run was stopped before the rows were written.');
    }

    const sql = await import('mssql');
    const pool = await sqlServerPool(connection);
    const transaction = new sql.default.Transaction(pool);
    await transaction.begin();
    let done = false;
    const stop = () => {
        if (!done) {
            done = true;
            void transaction.rollback().catch(() => undefined);
        }
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
        const answer =
            mode === 'insert'
                ? { results: await insertRows(sql.default as unknown as Sql, transaction, table, columns, rows, timeoutMs) }
                : mode === 'delete'
                  ? await deleteRows(sql.default as unknown as Sql, transaction, table, columns, rows, timeoutMs, signal)
                  : await updateRows(
                        sql.default as unknown as Sql,
                        transaction,
                        table,
                        columns,
                        rows,
                        match!,
                        conditions,
                        timeoutMs,
                        signal,
                    );
        done = true;
        await transaction.commit();
        return answer;
    } catch (e) {
        if (!done) {
            done = true;
            await transaction.rollback().catch(() => undefined);
        }
        throw signal.aborted ? new Error('The run was stopped: nothing of the batch was written.') : e;
    } finally {
        signal.removeEventListener('abort', stop);
    }
};
