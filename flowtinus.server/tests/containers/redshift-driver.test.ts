import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { flowRunner, type ExecutableFlow } from '@flowtinus/core';
import { evaluate } from '#shared/runner/evaluate';
import { closeRedshiftPools, queryRedshift } from '#shared/runner/redshift-driver';
import { writeRedshift } from '#shared/runner/redshift-write-driver';
import { executeRedshift } from '#shared/runner/redshift-execute-driver';

/*
 * Redshift Query's driver against a real Postgres (Testcontainers; skipped without Docker): Redshift speaks the Postgres
 * protocol, and what the driver does (cursor, READ ONLY transaction, statement_timeout, parameters) is the same there.
 */

setDefaultTimeout(120_000);

const pg: StartedTestContainer | null = await new GenericContainer('postgres:17.6-alpine')
    .withEnvironment({ POSTGRES_USER: 'reader', POSTGRES_PASSWORD: 'Rs-test-pw/1', POSTGRES_DB: 'sales' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start()
    .catch(() => null);

afterAll(async () => {
    await closeRedshiftPools();
    await pg?.stop().catch(() => undefined);
});

const rowsOf = async <T>(rows: AsyncIterable<T>) => {
    const all: T[] = [];
    for await (const row of rows) {
        all.push(row);
    }
    return all;
};

describe.skipIf(!pg)('Redshift driver (a Postgres container)', () => {
    const connection = `postgres://reader:${encodeURIComponent('Rs-test-pw/1')}@${pg?.getHost()}:${pg?.getMappedPort(5432)}/sales?sslmode=disable`;
    const run = (sql: string, parameters: Record<string, unknown> = {}, signal = new AbortController().signal, timeoutMs = 30_000) =>
        queryRedshift({ connection, sql, parameters, timeoutMs, signal });

    test('rows read through the cursor, past one batch; @names bound, never pasted into the text', async () => {
        // the setup writes, so it goes through pg directly: the driver's READ ONLY transaction would refuse it
        const { default: pgLib } = await import('pg');
        const setup = new pgLib.Client({ connectionString: connection.replace('?sslmode=disable', '') });
        await setup.connect();
        await setup.query('CREATE TABLE customers (id int PRIMARY KEY, name text, region text)');
        await setup.query(
            "INSERT INTO customers SELECT i, 'customer ' || i, CASE WHEN i % 2 = 0 THEN 'south' ELSE 'north' END FROM generate_series(1, 1200) i",
        );
        await setup.end();

        expect((await rowsOf(run('SELECT id FROM customers ORDER BY id'))).length).toBe(1200);
        const rows = await rowsOf(
            run('SELECT id, name FROM customers WHERE id > @min AND region = @Region ORDER BY id', { min: 1194, region: 'south' }),
        );
        expect(rows).toEqual([
            { id: 1196, name: 'customer 1196' },
            { id: 1198, name: 'customer 1198' },
            { id: 1200, name: 'customer 1200' },
        ]);
        expect(await rowsOf(run('SELECT id FROM customers WHERE name = @name', { name: "x'; DROP TABLE customers; --" }))).toEqual([]);
        expect(await rowsOf(run('SELECT count(*)::int AS n FROM customers'))).toEqual([{ n: 1200 }]);
    });

    test('a write that got past the check is refused by the READ ONLY transaction', async () => {
        await expect(rowsOf(run("INSERT INTO customers VALUES (9999, 'x', 'x')"))).rejects.toThrow(/read-only transaction/);
        expect(await rowsOf(run('SELECT count(*)::int AS n FROM customers'))).toEqual([{ n: 1200 }]);
    });

    test('the timeout, the flow that stops taking rows, and Stop', async () => {
        await expect(rowsOf(run('SELECT pg_sleep(5)', {}, new AbortController().signal, 300))).rejects.toThrow(/statement timeout/);

        let taken = 0;
        for await (const _ of run('SELECT id FROM customers')) {
            if (++taken === 3) {
                break;
            }
        }
        expect(taken).toBe(3);

        const stop = new AbortController();
        const slow = rowsOf(run('SELECT pg_sleep(20)', {}, stop.signal));
        setTimeout(() => stop.abort(), 300);
        const started = performance.now();
        await slow.catch(() => undefined);
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(await rowsOf(run('SELECT 1 AS ok'))).toEqual([{ ok: 1 }]);
    });

    test('through the engine: a Redshift Query with a profile and its password secret; the password never in the record', async () => {
        const flow: ExecutableFlow = {
            project: 'Test',
            flow: 'Redshift',
            parameters: [],
            nodes: [
                { id: 'start', type: 'start', label: 'Start', config: {} },
                {
                    id: 'r',
                    type: 'redshift',
                    label: 'Customers',
                    override: true,
                    config: {
                        connection: 'dw',
                        sql: 'SELECT id FROM customers WHERE id <= @n ORDER BY id',
                        parameters: [{ name: 'n', value: '2', expression: true }],
                    },
                },
                { id: 'end', type: 'end', label: 'End', config: {} },
            ],
            edges: [
                { source: 'start', sourcePort: 'out-0', target: 'r', targetPort: 'in-0' },
                { source: 'r', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
            ],
        };
        const record = await flowRunner(flow, {
            mode: 'execution',
            id: 'rs',
            evaluate,
            databases: { redshift: queryRedshift },
            secrets: { DW: 'Rs-test-pw/1' },
            connections: {
                dw: {
                    name: 'DW',
                    type: 'redshift',
                    config: {
                        host: pg!.getHost(),
                        port: String(pg!.getMappedPort(5432)),
                        database: 'sales',
                        user: 'reader',
                        password: 'DW',
                        ssl: 'off',
                    },
                },
            },
        });
        expect(record.status).toBe('completed');
        expect(record.components.find(c => c.nodeId === 'r')!.outputSample['out-0']).toEqual([{ id: 1 }, { id: 2 }]);
        expect(JSON.stringify(record)).not.toContain('Rs-test-pw');
    });
});

describe.skipIf(!pg)('Redshift write driver (a Postgres container)', () => {
    const connection = `postgres://reader:${encodeURIComponent('Rs-test-pw/1')}@${pg?.getHost()}:${pg?.getMappedPort(5432)}/sales?sslmode=disable`;
    const write = (rows: unknown[][], match?: string[], table = 'public.contacts') =>
        writeRedshift({
            connection,
            table,
            columns: ['email', 'name', 'score'],
            rows,
            mode: match ? 'upsert' : 'insert',
            ...(match ? { match } : {}),
            timeoutMs: 30_000,
            signal: new AbortController().signal,
        });
    const contacts = async () =>
        rowsOf(
            queryRedshift({
                connection,
                sql: 'SELECT email, name, score FROM contacts ORDER BY email',
                parameters: {},
                timeoutMs: 30_000,
                signal: new AbortController().signal,
            }),
        );

    test('insert: every row, in groups under the parameter limit; values only as parameters', async () => {
        const { default: pgLib } = await import('pg');
        const setup = new pgLib.Client({ connectionString: connection.replace('?sslmode=disable', '') });
        await setup.connect();
        await setup.query('CREATE TABLE contacts (email text NOT NULL, name text, score int)');
        await setup.end();

        expect(
            await write([
                ['a@x.com', "O'Brien; DROP TABLE contacts", 1],
                ['b@x.com', 'Bia', 2],
            ]),
        ).toEqual({ results: ['inserted', 'inserted'] });
        // 12000 rows x 3 values: more than one statement's parameters
        const many = Array.from({ length: 12_000 }, (_, i) => [`m${i}@x.com`, null, i]);
        expect((await write(many)).results).toHaveLength(12_000);
        expect(
            (
                await rowsOf(
                    queryRedshift({
                        connection,
                        sql: 'SELECT count(*)::int AS n FROM contacts',
                        parameters: {},
                        timeoutMs: 30_000,
                        signal: new AbortController().signal,
                    }),
                )
            )[0],
        ).toEqual({ n: 12_002 });
        expect((await contacts())[0]).toEqual({ email: 'a@x.com', name: "O'Brien; DROP TABLE contacts", score: 1 });
    });

    test('upsert: matched rows updated, new ones inserted, the last of the same key wins', async () => {
        const { results } = await write(
            [
                ['a@x.com', 'Ana', 10],
                ['c@x.com', 'Caio', 3],
                ['c@x.com', 'Caio 2', 4],
            ],
            ['email'],
        );
        expect(results).toEqual(['updated', 'superseded', 'inserted']);
        const rows = await contacts();
        expect(rows.find(r => r.email === 'a@x.com')).toEqual({ email: 'a@x.com', name: 'Ana', score: 10 });
        expect(rows.filter(r => r.email === 'c@x.com')).toEqual([{ email: 'c@x.com', name: 'Caio 2', score: 4 }]);
    });

    test('a batch that fails writes nothing of it; the connection is still good', async () => {
        const before = (await contacts()).length;
        await expect(
            write([
                ['d@x.com', 'Dani', 1],
                [null, 'no email', 2],
            ]),
        ).rejects.toThrow(/null value/);
        await expect(
            write(
                [
                    ['e@x.com', 'Eva', 1],
                    [null, 'no email', 2],
                ],
                ['email'],
            ),
        ).rejects.toThrow(/null value/);
        expect((await contacts()).length).toBe(before);
        expect((await write([['f@x.com', 'Fê', 1]], ['email'])).results).toEqual(['inserted']);
    });

    test('delete: every row whose columns all equal the values, in one DELETE; how many each deleted; a repeated key finds nothing', async () => {
        const remove = (columns: string[], rows: unknown[][]) =>
            writeRedshift({
                connection,
                table: 'public.contacts',
                columns,
                rows,
                mode: 'delete',
                timeoutMs: 30_000,
                signal: new AbortController().signal,
            });
        await write([
            ['g@x.com', 'Gil', 7],
            ['g@x.com', 'Gil again', 8],
            ['h@x.com', 'Hel', 7],
        ]);
        const before = (await contacts()).length;
        expect(await remove(['email'], [['g@x.com'], ["x'; DROP TABLE contacts; --"], ['g@x.com']])).toEqual({
            results: ['deleted', 'notFound', 'notFound'],
            rows: [2, 0, 0],
        });
        expect(
            await remove(
                ['email', 'score'],
                [
                    ['h@x.com', 1],
                    ['h@x.com', 7],
                ],
            ),
        ).toEqual({ results: ['notFound', 'deleted'], rows: [0, 1] });
        const rows = await contacts();
        expect(rows.length).toBe(before - 3);
        expect(rows.some(r => r.email === 'g@x.com' || r.email === 'h@x.com')).toBe(false);
        // a failure (text into an int) deletes nothing of the batch
        await expect(
            remove(
                ['email', 'score'],
                [
                    ['a@x.com', 10],
                    ['b@x.com', 'not a number'],
                ],
            ),
        ).rejects.toThrow();
        expect((await contacts()).length).toBe(before - 3);
    });

    test('execute: the statements one after the other in one transaction; At the end; a COMMIT of the SQL is its own', async () => {
        const exec = (sql: string, parameters: Record<string, unknown> = {}, atEnd: 'commit' | 'rollback' = 'commit') =>
            executeRedshift({ connection, sql, parameters, atEnd, timeoutMs: 30_000, signal: new AbortController().signal });
        await exec('CREATE TABLE IF NOT EXISTS projects (brief_id int, name text)');
        await exec('DELETE FROM projects');
        const count = async () => (await exec('SELECT count(*)::int AS n FROM projects')).rows[0]!.n;

        // a replace: the delete and the inserts commit together; the answer has the rows changed and the last rows
        expect(
            await exec(
                "INSERT INTO projects VALUES (@id, 'old');\nDELETE FROM projects WHERE brief_id = @id;\nINSERT INTO projects VALUES (@id, @a), (@id, @b);\nSELECT name FROM projects WHERE brief_id = @id ORDER BY name;",
                { id: 1, a: "x'; DROP TABLE projects; --", b: 'b' },
            ),
        ).toEqual({ rowsAffected: 4, rows: [{ name: 'b' }, { name: "x'; DROP TABLE projects; --" }], transaction: 'committed' });
        expect(await count()).toBe(2);

        // a failure in the second statement rolls the first back
        await expect(
            exec('DELETE FROM projects WHERE brief_id = @id; INSERT INTO projects VALUES (@id, 1/0)', { id: 1 }),
        ).rejects.toThrow();
        expect(await count()).toBe(2);

        // At the end Rollback: nothing stays; but what the SQL commits itself does
        expect((await exec('DELETE FROM projects', {}, 'rollback')).transaction).toBe('rolledBack');
        expect(await count()).toBe(2);
        expect(
            (await exec("INSERT INTO projects VALUES (2, 'kept'); COMMIT; INSERT INTO projects VALUES (3, 'autocommit')", {}, 'rollback'))
                .transaction,
        ).toBe('sql');
        expect(await count()).toBe(4);
        expect((await exec("BEGIN; INSERT INTO projects VALUES (4, 'dropped')", {}, 'rollback')).transaction).toBe('rolledBack');
        expect(await count()).toBe(4);
    });
});
