import { blankSql, positionalSql, splitStatements, type ExecuteSql, type SqlExecuteAnswer } from '@flowtinus/core';
import { redshiftPool } from './redshift-driver';

/*
 * Redshift Execute's driver, in the worker: the SQL split into its statements (the Postgres protocol takes parameters
 * only in a single statement), each run with its own @names as $1, $2..., one after the other on one connection, in a
 * transaction opened here, with the component's statement_timeout. Nothing checks what they do.
 *
 * A statement that ends the transaction (COMMIT, END, ROLLBACK, ABORT) is the SQL's own: what follows runs as the
 * database runs it (each statement on its own, or in the transaction a BEGIN opens). What is still open at the end gets
 * At the end (COMMIT or ROLLBACK). A failure rolls back what is still open; Stop drops the connection, which does too.
 */

const ENDS = /^(COMMIT|END|ABORT|ROLLBACK)\b(?!\s+TO\b)(?!\s+(WORK|TRANSACTION)\s+TO\b)/i;
const BEGINS = /^(BEGIN|START\s+TRANSACTION)\b/i;
const CHANGES = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY']);

export const executeRedshift: ExecuteSql = async ({ connection, sql, parameters, atEnd, timeoutMs, signal }) => {
    if (signal.aborted) {
        throw new Error('The run was stopped before the SQL ran.');
    }
    const lower = new Map(Object.entries(parameters).map(([name, value]) => [name.toLowerCase(), value]));
    const statements = splitStatements(sql, 'redshift').map(statement => {
        const { text, names } = positionalSql(statement);
        const values = names.map(name => {
            if (!lower.has(name.toLowerCase())) {
                throw new Error(`The SQL uses @${name}, which is not in the parameters.`);
            }
            return lower.get(name.toLowerCase()) ?? null;
        });
        return { text, values, head: blankSql(statement, 'redshift').trim() };
    });
    if (statements.length === 0) {
        throw new Error('The SQL has no statement.');
    }

    const pool = await redshiftPool(connection);
    const client = await pool.connect();
    let broken = false;
    const cancel = () => {
        broken = true;
        client.release(true);
    };
    signal.addEventListener('abort', cancel, { once: true });
    let open = false;
    let succeeded = false;
    try {
        await client.query(`SET statement_timeout TO ${Math.max(1, Math.round(timeoutMs))}`);
        await client.query('BEGIN');
        open = true;
        const answer: SqlExecuteAnswer = { rowsAffected: 0, rows: [], transaction: 'committed' };
        for (const { text, values, head } of statements) {
            const result = await client.query<Record<string, unknown>>(text, values);
            if (CHANGES.has(String(result.command).toUpperCase())) {
                answer.rowsAffected += result.rowCount ?? 0;
            }
            if (result.fields?.length) {
                answer.rows = result.rows;
            }
            if (ENDS.test(head)) {
                open = false;
            } else if (BEGINS.test(head)) {
                open = true;
            }
        }
        if (open) {
            await client.query(atEnd === 'commit' ? 'COMMIT' : 'ROLLBACK');
            answer.transaction = atEnd === 'commit' ? 'committed' : 'rolledBack';
        } else {
            answer.transaction = 'sql';
        }
        succeeded = true;
        return answer;
    } catch (e) {
        if (signal.aborted) {
            throw new Error('The run was stopped: what was still open was rolled back.');
        }
        throw e;
    } finally {
        signal.removeEventListener('abort', cancel);
        if (!broken) {
            // after a failure the transaction may still be open: rolled back, the connection kept only if that worked
            const ok =
                succeeded ||
                (await client.query('ROLLBACK').then(
                    () => true,
                    () => false,
                ));
            client.release(!ok);
        }
    }
};
