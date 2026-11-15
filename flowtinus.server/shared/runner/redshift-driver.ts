import { positionalSql, type QueryDatabase } from '@flowtinus/core';
import type { Pool, PoolClient } from 'pg';

/*
 * Redshift Query's driver, in the worker (pg, the Postgres protocol Redshift speaks): the rows read through a cursor, a
 * batch at a time, only when the flow takes them (backpressure); the @names bound as $1, $2... (never pasted into the
 * text); inside a READ ONLY transaction that always rolls back (the second layer of read-only, after the core's check),
 * with the query's own statement_timeout; Stop drops the connection, which ends the query in the database. The pools are
 * kept per connection string in this worker (the process is recycled after a number of runs, the pools with it).
 */

const BATCH = 500;
const KEPT_POOLS = 8;

const pools = new Map<string, Pool>();

export async function redshiftPool(connection: string): Promise<Pool> {
    const known = pools.get(connection);
    if (known) {
        pools.delete(connection);
        pools.set(connection, known);
        return known;
    }

    const { default: pg } = await import('pg');
    const url = new URL(connection);
    const ssl = url.searchParams.get('sslmode');
    url.searchParams.delete('sslmode');
    const pool = new pg.Pool({
        connectionString: url.toString(),
        // Redshift's certificate is checked like any other; sslmode=disable turns SSL off (a local Postgres in the tests)
        ssl: ssl === 'disable' ? false : { rejectUnauthorized: true },
        max: 4,
        idleTimeoutMillis: 60_000,
        application_name: 'flowtinus',
    });
    // an idle connection the server dropped: the pool takes it out, the worker goes on
    pool.on('error', () => undefined);
    pools.set(connection, pool);
    if (pools.size > KEPT_POOLS) {
        const [oldest, gone] = pools.entries().next().value!;
        pools.delete(oldest);
        void gone.end().catch(() => undefined);
    }

    return pool;
}

export async function closeRedshiftPools() {
    const all = [...pools.values()];
    pools.clear();
    await Promise.all(all.map(p => p.end().catch(() => undefined)));
}

export const queryRedshift: QueryDatabase = async function* ({ connection, sql, parameters, timeoutMs, signal }) {
    if (signal.aborted) {
        return;
    }

    const { default: Cursor } = await import('pg-cursor');
    const { text, names } = positionalSql(sql);
    const lower = new Map(Object.entries(parameters).map(([name, value]) => [name.toLowerCase(), value]));
    const values = names.map(name => {
        const value = lower.get(name.toLowerCase());
        if (value === undefined && !lower.has(name.toLowerCase())) {
            throw new Error(`The query uses @${name}, which is not in the parameters.`);
        }
        return value ?? null;
    });

    const pool = await redshiftPool(connection);
    const client: PoolClient = await pool.connect();
    let broken = false;
    // Stop: the connection is dropped (the database ends the query) and not given back to the pool
    const cancel = () => {
        broken = true;
        client.release(true);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SET statement_timeout TO ${Math.max(1, Math.round(timeoutMs))}`);
        const cursor = client.query(new Cursor<Record<string, unknown>>(text, values));
        try {
            while (!signal.aborted) {
                const rows = await cursor.read(BATCH);
                for (const row of rows) {
                    yield row;
                }

                if (rows.length < BATCH) {
                    return;
                }
            }
        } finally {
            if (!broken) {
                await cursor.close().catch(() => undefined);
            }
        }
    } catch (e) {
        if (signal.aborted) {
            return;
        }
        throw e;
    } finally {
        signal.removeEventListener('abort', cancel);
        if (!broken) {
            const ok = await client.query('ROLLBACK').then(
                () => true,
                () => false,
            );
            client.release(!ok);
        }
    }
};
