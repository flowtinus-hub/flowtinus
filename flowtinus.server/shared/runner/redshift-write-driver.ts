import type { RowWriteAnswer, RowWriteResult, WriteRows } from '@flowtinus/core';
import type { PoolClient } from 'pg';
import { redshiftPool } from './redshift-driver';

/*
 * Redshift Insert, Upsert and Delete's driver, in the worker: the batch in one transaction (all of it, or none), with the
 * component's own statement_timeout; Stop drops the connection, which rolls it back. The table and column names come
 * checked by the core (letters, digits, _ and $), so they go into the text as they are; every value goes as a parameter.
 *
 * Insert: INSERT ... VALUES (...), (...) in groups under the parameter limit. Upsert: the rows go to a temporary table
 * with their position; the earlier ones with the same match values are dropped (the last wins: superseded); the rows of
 * the table that match are updated (UPDATE ... FROM) and the others inserted (INSERT ... WHERE NOT EXISTS), which every
 * Redshift takes (MERGE is newer and refuses two source rows for one target row).
 *
 * Delete: the rows' values go to a temporary table with their position; how many rows of the table each one matches is
 * counted (a later row with the same values as an earlier one finds nothing, as if they were deleted one after the
 * other), then one DELETE ... USING deletes them all.
 */

/** values in one statement: Postgres and Redshift take at most 32767 parameters */
const MAX_PARAMETERS = 32_000;

/** the staging table of an upsert: temporary, per connection, so a fixed name is enough */
const STAGING = 'flowtinus_upsert_staging';
const DELETE_STAGING = 'flowtinus_delete_staging';
const ROW = 'flowtinus_row';

function chunks<T>(rows: T[], perRow: number): T[][] {
    const size = Math.max(1, Math.floor(MAX_PARAMETERS / Math.max(1, perRow)));
    const groups: T[][] = [];
    for (let i = 0; i < rows.length; i += size) {
        groups.push(rows.slice(i, i + size));
    }
    return groups;
}

function valuesOf(rows: unknown[][]): { placeholders: string; values: unknown[] } {
    let n = 0;
    return {
        placeholders: rows.map(row => `(${row.map(() => `$${++n}`).join(', ')})`).join(', '),
        values: rows.flat(),
    };
}

async function insertRows(client: PoolClient, table: string, columns: string[], rows: unknown[][]) {
    for (const group of chunks(rows, columns.length)) {
        const { placeholders, values } = valuesOf(group);
        await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders}`, values);
    }
}

async function upsertRows(
    client: PoolClient,
    table: string,
    columns: string[],
    rows: unknown[][],
    match: string[],
): Promise<RowWriteResult[]> {
    const list = columns.join(', ');
    const same = (a: string, b: string) => match.map(m => `${a}.${m} = ${b}.${m}`).join(' AND ');
    const later = `EXISTS (SELECT 1 FROM ${STAGING} l WHERE ${same('l', 's')} AND l.${ROW} > s.${ROW})`;

    await client.query(`DROP TABLE IF EXISTS ${STAGING}`);
    await client.query(`CREATE TEMP TABLE ${STAGING} AS SELECT ${list} FROM ${table} WHERE 1 = 0`);
    await client.query(`ALTER TABLE ${STAGING} ADD COLUMN ${ROW} int`);
    await insertRows(
        client,
        STAGING,
        [...columns, ROW],
        rows.map((row, i) => [...row, i]),
    );

    const superseded = await client.query<{ row: number }>(`SELECT s.${ROW} AS row FROM ${STAGING} s WHERE ${later}`);
    if (superseded.rows.length > 0) {
        await client.query(`DELETE FROM ${STAGING} WHERE ${ROW} IN (${superseded.rows.map(r => Number(r.row)).join(', ')})`);
    }
    const updated = await client.query<{ row: number }>(`SELECT s.${ROW} AS row FROM ${STAGING} s JOIN ${table} t ON ${same('t', 's')}`);

    const others = columns.filter(c => !match.some(m => m.toLowerCase() === c.toLowerCase()));
    if (others.length > 0 && updated.rows.length > 0) {
        await client.query(
            `UPDATE ${table} AS t SET ${others.map(c => `${c} = s.${c}`).join(', ')} FROM ${STAGING} s WHERE ${same('t', 's')}`,
        );
    }
    await client.query(
        `INSERT INTO ${table} (${list}) SELECT ${list} FROM ${STAGING} s WHERE NOT EXISTS (SELECT 1 FROM ${table} t WHERE ${same('t', 's')})`,
    );
    await client.query(`DROP TABLE ${STAGING}`);

    const results: RowWriteResult[] = rows.map(() => 'inserted');
    for (const { row } of superseded.rows) {
        results[Number(row)] = 'superseded';
    }
    for (const { row } of updated.rows) {
        results[Number(row)] = 'updated';
    }
    return results;
}

async function deleteRows(client: PoolClient, table: string, columns: string[], rows: unknown[][]) {
    if (columns.length === 0) {
        throw new Error('A delete needs at least one Match on column.');
    }
    // DELETE takes no alias: the table's own name (without its schema) qualifies its columns
    const name = table.split('.').pop()!;
    const same = (a: string, b: string) => columns.map(c => `${a}.${c} = ${b}.${c}`).join(' AND ');

    await client.query(`DROP TABLE IF EXISTS ${DELETE_STAGING}`);
    await client.query(`CREATE TEMP TABLE ${DELETE_STAGING} AS SELECT ${columns.join(', ')} FROM ${table} WHERE 1 = 0`);
    await client.query(`ALTER TABLE ${DELETE_STAGING} ADD COLUMN ${ROW} int`);
    await insertRows(
        client,
        DELETE_STAGING,
        [...columns, ROW],
        rows.map((row, i) => [...row, i]),
    );
    // the first of the rows with the same values counts what they delete; the later ones find nothing
    const counted = await client.query<{ row: number; n: number | string }>(
        `SELECT s.${ROW} AS row, COUNT(*) AS n FROM ${DELETE_STAGING} s JOIN ${table} t ON ${same('t', 's')} ` +
            `WHERE NOT EXISTS (SELECT 1 FROM ${DELETE_STAGING} e WHERE ${same('e', 's')} AND e.${ROW} < s.${ROW}) GROUP BY s.${ROW}`,
    );
    if (counted.rows.length > 0) {
        await client.query(`DELETE FROM ${table} USING ${DELETE_STAGING} s WHERE ${same(name, 's')}`);
    }
    await client.query(`DROP TABLE ${DELETE_STAGING}`);

    const results: RowWriteResult[] = rows.map(() => 'notFound');
    const deleted = rows.map(() => 0);
    for (const { row, n } of counted.rows) {
        results[Number(row)] = 'deleted';
        deleted[Number(row)] = Number(n);
    }
    return { results, rows: deleted };
}

export const writeRedshift: WriteRows = async ({ connection, table, columns, rows, mode, match, timeoutMs, signal }) => {
    if (mode === 'update') {
        throw new Error('Redshift has no Update component: use a Redshift Upsert.');
    }
    if (signal.aborted) {
        throw new Error('The run was stopped before the rows were written.');
    }

    const pool = await redshiftPool(connection);
    const client = await pool.connect();
    let broken = false;
    const cancel = () => {
        broken = true;
        client.release(true);
    };
    signal.addEventListener('abort', cancel, { once: true });
    let committed = false;
    try {
        await client.query('BEGIN');
        await client.query(`SET statement_timeout TO ${Math.max(1, Math.round(timeoutMs))}`);
        let answer: RowWriteAnswer;
        if (mode === 'delete') {
            answer = await deleteRows(client, table, columns, rows);
        } else if (mode === 'upsert' && match?.length) {
            answer = { results: await upsertRows(client, table, columns, rows, match) };
        } else {
            await insertRows(client, table, columns, rows);
            answer = { results: rows.map(() => 'inserted') };
        }
        await client.query('COMMIT');
        committed = true;
        return answer;
    } catch (e) {
        if (signal.aborted) {
            throw new Error('The run was stopped: nothing of the batch was written.');
        }
        throw e;
    } finally {
        signal.removeEventListener('abort', cancel);
        if (!broken) {
            const ok =
                committed ||
                (await client.query('ROLLBACK').then(
                    () => true,
                    () => false,
                ));
            client.release(!ok);
        }
    }
};
