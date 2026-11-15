import type { ExecuteSql } from '@flowtinus/core';
import { sqlServerPool } from './sqlserver-driver';

/*
 * SQL Server Execute's driver, in the worker (mssql): the SQL as one batch, inside a transaction and a TRY that this
 * driver wraps around it, with XACT_ABORT ON (an error ends the batch and dooms the transaction), every @name a
 * parameter, the component's timeout; Stop cancels the request, which rolls back. Nothing checks what the SQL does.
 *
 * A COMMIT or ROLLBACK in the SQL is its own. What is still open at the end (@@TRANCOUNT > 0, a BEGIN TRAN of the SQL
 * included) gets At the end: committed or rolled back. An error rolls back what is still open and comes back as it was
 * (THROW). Since the SQL runs inside BEGIN TRY, what SQL Server takes only first in a batch (CREATE PROCEDURE, VIEW...)
 * goes through EXEC('...'); GO is not T-SQL and is not taken.
 *
 * rowsAffected: what SQL Server counts, without the rows a SELECT returns (those are rows read, not changed) and
 * without this driver's own statements. An assignment (DECLARE @n int = 2, SET @n, SELECT @n = ...) counts as SQL Server
 * counts it: 1. With SET NOCOUNT ON in the SQL, SQL Server counts nothing: 0.
 */

/** the output parameter with @@TRANCOUNT before the end: 0 means the SQL ended the transaction itself */
const OPEN = 'flowtinus_open_transactions';

export const executeSqlServer: ExecuteSql = async ({ connection, sql, parameters, atEnd, timeoutMs, signal }) => {
    if (signal.aborted) {
        throw new Error('The run was stopped before the SQL ran.');
    }
    const mssql = (await import('mssql')).default;
    const pool = await sqlServerPool(connection);
    const request = pool.request();
    (request as unknown as { timeout: number }).timeout = timeoutMs;
    for (const [name, value] of Object.entries(parameters)) {
        request.input(name, value ?? null);
    }
    request.output(OPEN, mssql.Int);
    const end = atEnd === 'commit' ? 'WHILE @@TRANCOUNT > 0 COMMIT TRANSACTION;' : 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;';
    const text = [
        'SET XACT_ABORT ON;',
        'BEGIN TRY',
        'BEGIN TRANSACTION;',
        sql,
        ';',
        // the driver's own assignment is not one of the SQL's rows
        'SET NOCOUNT ON;',
        `SET @${OPEN} = @@TRANCOUNT;`,
        'SET NOCOUNT OFF;',
        end,
        'END TRY',
        'BEGIN CATCH',
        'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;',
        'THROW;',
        'END CATCH',
    ].join('\n');

    const cancel = () => request.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
        const result = await request.query<Record<string, unknown>>(text);
        const sets = (result.recordsets as unknown as Record<string, unknown>[][]) ?? [];
        const last = [...sets].reverse().find(set => set.length > 0) ?? [];
        const open = Number(result.output[OPEN] ?? 0);
        // mssql's counts include each SELECT's (its rows, the same as its recordset's length)
        const counted = (result.rowsAffected ?? []).reduce((a, b) => a + b, 0);
        const read = sets.reduce((a, set) => a + set.length, 0);
        return {
            rowsAffected: Math.max(0, counted - read),
            rows: last.map(row => ({ ...row })),
            transaction: open > 0 ? (atEnd === 'commit' ? 'committed' : 'rolledBack') : 'sql',
        };
    } catch (e) {
        if (signal.aborted) {
            throw new Error('The run was stopped: what was still open was rolled back.');
        }
        throw e;
    } finally {
        signal.removeEventListener('abort', cancel);
    }
};
