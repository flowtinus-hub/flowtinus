import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { flowRunner, type ExecutableFlow } from '@flowtinus/core';
import { evaluate } from '#shared/runner/evaluate';
import { closeSqlServerPools, querySqlServer } from '#shared/runner/sqlserver-driver';
import { writeSqlServer } from '#shared/runner/sqlserver-write-driver';
import { executeSqlServer } from '#shared/runner/sqlserver-execute-driver';
import { aggregateMongoDb, closeMongoClients, deleteMongoDb, upsertMongoDb } from '#shared/runner/mongodb-driver';

/*
 * The worker's database drivers against real databases (Testcontainers): SQL Server and MongoDB, each in a container of
 * its own (skipped without Docker). Directly, and through the engine with a component, a connection profile and a
 * secret.
 */

setDefaultTimeout(180_000);

const SA_PASSWORD = 'Df-test-Passw0rd!';
const start = (container: GenericContainer) => container.start().catch(() => null);
const [mssql, mongo] = await Promise.all([
    start(
        new GenericContainer('mcr.microsoft.com/mssql/server:2022-latest')
            .withEnvironment({ ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: SA_PASSWORD })
            .withExposedPorts(1433)
            .withWaitStrategy(Wait.forLogMessage(/SQL Server is now ready for client connections/))
            .withStartupTimeout(150_000),
    ),
    start(new GenericContainer('mongo:8.0').withExposedPorts(27017).withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))),
]);

afterAll(async () => {
    await closeSqlServerPools();
    await closeMongoClients();
    await Promise.all([mssql, mongo].map(c => (c as StartedTestContainer | null)?.stop().catch(() => undefined)));
});

const signal = () => new AbortController().signal;
const rowsOf = async <T>(rows: AsyncIterable<T>) => {
    const all: T[] = [];
    for await (const row of rows) {
        all.push(row);
    }

    return all;
};

describe.skipIf(!mssql)('SQL Server driver (container)', () => {
    const host = mssql?.getHost() ?? '';
    const port = mssql?.getMappedPort(1433) ?? 0;
    const connection = `Server=${host},${port};Database=master;User Id=sa;Password=${SA_PASSWORD};Encrypt=false;TrustServerCertificate=true`;
    const run = (sql: string, parameters: Record<string, unknown> = {}, s = signal()) =>
        querySqlServer({ connection, sql, parameters, timeoutMs: 30_000, signal: s });

    // "ready for client connections" comes before the sa login works: tried until it does
    beforeAll(async () => {
        for (let i = 0; i < 60; i++) {
            try {
                await rowsOf(run('SELECT 1 AS ok'));
                return;
            } catch {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    });

    test('rows streamed with their types; parameters bound, never pasted into the text', async () => {
        await rowsOf(
            run("IF OBJECT_ID('dbo.Customer') IS NULL CREATE TABLE dbo.Customer (id int PRIMARY KEY, name nvarchar(50), since datetime2)"),
        );
        await rowsOf(run('DELETE FROM dbo.Customer'));
        await rowsOf(
            run(`WITH n AS (SELECT TOP (1200) ROW_NUMBER() OVER (ORDER BY (SELECT 1)) AS i FROM sys.all_objects a CROSS JOIN sys.all_objects b)
INSERT INTO dbo.Customer (id, name, since) SELECT i, CONCAT('customer ', i), DATEADD(day, i, '2026-01-01') FROM n`),
        );

        const rows = await rowsOf(run('SELECT id, name, since FROM dbo.Customer WHERE id > @min ORDER BY id', { min: 1190 }));
        expect(rows.map(r => r.id)).toEqual([1191, 1192, 1193, 1194, 1195, 1196, 1197, 1198, 1199, 1200]);
        expect(rows[0]!.name).toBe('customer 1191');
        expect(rows[0]!.since).toBeInstanceOf(Date);

        // a value that would be SQL if pasted: only a value
        expect(await rowsOf(run('SELECT id FROM dbo.Customer WHERE name = @name', { name: "x'; DROP TABLE dbo.Customer; --" }))).toEqual(
            [],
        );
        expect((await rowsOf(run('SELECT COUNT(*) AS n FROM dbo.Customer')))[0]!.n).toBe(1200);
    });

    test('all of a large result goes through the pauses; the flow can stop taking rows, or Stop the query', async () => {
        expect((await rowsOf(run('SELECT id FROM dbo.Customer ORDER BY id'))).length).toBe(1200);

        // only the first rows taken: the rest is not read, and the next query works
        let taken = 0;
        for await (const _ of run('SELECT id FROM dbo.Customer')) {
            taken += 1;
            if (taken === 3) {
                break;
            }
        }

        expect(taken).toBe(3);

        const stop = new AbortController();
        const slow = rowsOf(run("WAITFOR DELAY '00:00:20'; SELECT 1 AS x", {}, stop.signal));
        setTimeout(() => stop.abort(), 300);
        const started = performance.now();
        await slow.catch(() => undefined);
        expect(performance.now() - started).toBeLessThan(10_000);
    });

    test('through the engine: a SQL Server Query with a profile and its password secret; the password never in the record', async () => {
        const flow: ExecutableFlow = {
            project: 'Test',
            flow: 'SQL',
            parameters: [],
            nodes: [
                { id: 'start', type: 'start', label: 'Start', config: {} },
                {
                    id: 's',
                    type: 'sqlserver',
                    label: 'Customers',
                    override: true,
                    config: {
                        connection: 'db',
                        sql: 'SELECT id, name FROM dbo.Customer WHERE id <= @top ORDER BY id',
                        parameters: [{ name: 'top', value: '3', expression: true }],
                    },
                },
                { id: 'end', type: 'end', label: 'End', config: {} },
            ],
            edges: [
                { source: 'start', sourcePort: 'out-0', target: 's', targetPort: 'in-0' },
                { source: 's', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
            ],
        };
        const record = await flowRunner(flow, {
            mode: 'validation',
            id: 'sql-real',
            evaluate,
            databases: { sqlserver: querySqlServer },
            secrets: { SQL_PW: SA_PASSWORD },
            connections: {
                db: {
                    name: 'Local',
                    type: 'sqlserver',
                    config: {
                        host,
                        port: String(port),
                        database: 'master',
                        user: 'sa',
                        password: 'SQL_PW',
                        encrypt: 'off',
                        trustServerCertificate: 'on',
                    },
                },
            },
        });
        expect(record.status).toBe('completed');
        const s = record.components.find(c => c.nodeId === 's')!;
        expect(s.outputSample['out-0']).toEqual([
            { id: 1, name: 'customer 1' },
            { id: 2, name: 'customer 2' },
            { id: 3, name: 'customer 3' },
        ]);
        expect(s.waitingMs).toBeGreaterThan(0);
        expect(JSON.stringify(record)).not.toContain(SA_PASSWORD);
    });

    test('SQL Server Insert: every row, in groups under the parameter limit, in one transaction', async () => {
        await rowsOf(
            run(
                "IF OBJECT_ID('dbo.History') IS NULL CREATE TABLE dbo.History (Id int IDENTITY PRIMARY KEY, TicketId int NOT NULL, Note nvarchar(100), At datetime2)",
            ),
        );
        await rowsOf(run('DELETE FROM dbo.History'));
        const insert = (rows: unknown[][]) =>
            writeSqlServer({
                connection,
                table: 'dbo.History',
                columns: ['TicketId', 'Note', 'At'],
                rows,
                mode: 'insert',
                timeoutMs: 30_000,
                signal: new AbortController().signal,
            });

        // 2500 rows x 3 values: more than one request's parameters and more than one VALUES
        const many = Array.from({ length: 2500 }, (_, i) => [i, `note ${i}`, new Date('2026-11-08T00:00:00Z')]);
        expect((await insert(many)).results).toHaveLength(2500);
        expect(await rowsOf(run('SELECT COUNT(*) AS n FROM dbo.History'))).toEqual([{ n: 2500 }]);
        expect(await insert([[9999, "x'); DROP TABLE dbo.History; --", null]])).toEqual({ results: ['inserted'] });

        // a row that fails (no TicketId): none of the batch stays
        await expect(
            insert([
                [1, 'a', null],
                [null, 'b', null],
            ]),
        ).rejects.toThrow();
        expect(await rowsOf(run('SELECT COUNT(*) AS n FROM dbo.History'))).toEqual([{ n: 2501 }]);
    });

    test('SQL Server Update: one UPDATE per row in one transaction; rows changed or not found; a failure rolls the batch back', async () => {
        await rowsOf(
            run("IF OBJECT_ID('dbo.Ticket') IS NULL CREATE TABLE dbo.Ticket (Id int PRIMARY KEY, Status nvarchar(100), Score int)"),
        );
        await rowsOf(run('DELETE FROM dbo.Ticket'));
        await rowsOf(run("INSERT INTO dbo.Ticket (Id, Status, Score) VALUES (1, 'open', 0), (2, 'open', 0), (3, 'open', 0)"));
        const update = (rows: unknown[][]) =>
            writeSqlServer({
                connection,
                table: 'dbo.Ticket',
                columns: ['Id', 'Status', 'Score'],
                rows,
                mode: 'update',
                match: ['Id'],
                timeoutMs: 30_000,
                signal: new AbortController().signal,
            });
        const tickets = async () => rowsOf(run('SELECT Id, Status, Score FROM dbo.Ticket ORDER BY Id'));

        expect(
            await update([
                [1, "closed'; DROP TABLE dbo.Ticket; --", 5],
                [9, 'closed', 1],
            ]),
        ).toEqual({ results: ['updated', 'notFound'], rows: [1, 0] });
        expect((await tickets())[0]).toEqual({ Id: 1, Status: "closed'; DROP TABLE dbo.Ticket; --", Score: 5 });

        // the second row fails (text into an int): the first is rolled back too
        await expect(
            update([
                [2, 'closed', 7],
                [3, 'closed', 'not a number'],
            ]),
        ).rejects.toThrow();
        expect((await tickets()).slice(1)).toEqual([
            { Id: 2, Status: 'open', Score: 0 },
            { Id: 3, Status: 'open', Score: 0 },
        ]);
        expect((await update([[3, 'done', 1]])).results).toEqual(['updated']);
    });

    test('SQL Server Delete: one DELETE per row in one transaction; rows deleted or not found; a failure rolls the batch back', async () => {
        await rowsOf(
            run(
                "IF OBJECT_ID('dbo.Visit') IS NULL CREATE TABLE dbo.Visit (Id int IDENTITY PRIMARY KEY, CustomerId int, Kind nvarchar(100))",
            ),
        );
        await rowsOf(run('DELETE FROM dbo.Visit'));
        await rowsOf(run("INSERT INTO dbo.Visit (CustomerId, Kind) VALUES (1, 'web'), (1, 'web'), (1, 'shop'), (2, 'web'), (3, 'web')"));
        const remove = (columns: string[], rows: unknown[][]) =>
            writeSqlServer({
                connection,
                table: 'dbo.Visit',
                columns,
                rows,
                mode: 'delete',
                timeoutMs: 30_000,
                signal: new AbortController().signal,
            });
        const visits = async () => rowsOf(run('SELECT CustomerId, Kind FROM dbo.Visit ORDER BY Id'));

        expect(
            await remove(
                ['CustomerId', 'Kind'],
                [
                    [1, 'web'],
                    [1, "web'; DROP TABLE dbo.Visit; --"],
                    [1, 'web'],
                ],
            ),
        ).toEqual({ results: ['deleted', 'notFound', 'notFound'], rows: [2, 0, 0] });
        expect(await visits()).toEqual([
            { CustomerId: 1, Kind: 'shop' },
            { CustomerId: 2, Kind: 'web' },
            { CustomerId: 3, Kind: 'web' },
        ]);

        await expect(remove(['CustomerId'], [[2], ['not a number']])).rejects.toThrow();
        expect(await visits()).toHaveLength(3);
        expect(await remove(['CustomerId'], [[3]])).toEqual({ results: ['deleted'], rows: [1] });
    });

    test('SQL Server Execute: the batch in one transaction; At the end; a COMMIT of the SQL is its own; an error rolls back', async () => {
        await rowsOf(run("IF OBJECT_ID('dbo.Project') IS NULL CREATE TABLE dbo.Project (BriefId int, Name nvarchar(100))"));
        await rowsOf(run('DELETE FROM dbo.Project'));
        const exec = (sql: string, parameters: Record<string, unknown> = {}, atEnd: 'commit' | 'rollback' = 'commit') =>
            executeSqlServer({ connection, sql, parameters, atEnd, timeoutMs: 30_000, signal: new AbortController().signal });
        const count = async () => (await rowsOf(run('SELECT COUNT(*) AS n FROM dbo.Project')))[0]!.n;

        expect(
            await exec(
                "INSERT INTO dbo.Project VALUES (@id, 'old'); DELETE FROM dbo.Project WHERE BriefId = @id; DECLARE @n int = 2; INSERT INTO dbo.Project VALUES (@id, @a), (@id, @b); SELECT Name FROM dbo.Project WHERE BriefId = @id ORDER BY Name",
                { id: 1, a: "x'; DROP TABLE dbo.Project; --", b: 'b' },
            ),
        ).toEqual({ rowsAffected: 5, rows: [{ Name: 'b' }, { Name: "x'; DROP TABLE dbo.Project; --" }], transaction: 'committed' });
        expect(await count()).toBe(2);

        await expect(
            exec('DELETE FROM dbo.Project WHERE BriefId = @id; INSERT INTO dbo.Project VALUES (@id, 1/0)', { id: 1 }),
        ).rejects.toThrow();
        expect(await count()).toBe(2);

        expect((await exec('DELETE FROM dbo.Project', {}, 'rollback')).transaction).toBe('rolledBack');
        expect(await count()).toBe(2);
        expect((await exec("INSERT INTO dbo.Project VALUES (2, 'kept'); COMMIT;", {}, 'rollback')).transaction).toBe('sql');
        expect(await count()).toBe(3);
    });
});

describe.skipIf(!mongo)('MongoDB drivers (container)', () => {
    const connection = `mongodb://${mongo?.getHost()}:${mongo?.getMappedPort(27017)}`;
    const base = { connection, database: 'shop', collection: 'orders' };

    test('upserts in one bulk write, one result each (a duplicate fails alone); Extended JSON in, plain JSON out', async () => {
        const { MongoClient } = await import('mongodb');
        const client = await new MongoClient(connection).connect();
        await client.db('shop').collection('orders').deleteMany({});
        await client.db('shop').collection('orders').createIndex({ code: 1 }, { unique: true }, undefined);
        await client
            .db('shop')
            .collection('orders')
            .insertOne({ _id: '64f1a2b3c4d5e6f708091a2b' as never, code: 'A', total: 1 });
        await client.close();

        const answer = await upsertMongoDb({
            ...base,
            signal: signal(),
            upserts: [
                { filter: { code: 'A' }, document: { total: 10, at: { $date: '2026-11-04T12:00:00Z' } } },
                { filter: { code: 'B' }, document: { total: 20 } },
                // a new document with A's code: the unique index refuses it, the others go through
                { filter: { code: 'C' }, document: { code: 'A' } },
            ],
        });
        expect(answer.results[0]).toEqual({ matched: 1, upsertedId: null });
        expect(answer.results[1]).toMatchObject({ matched: 0 });
        expect(typeof (answer.results[1] as { upsertedId: string }).upsertedId).toBe('string');
        expect((answer.results[2] as { error: string }).error).toContain('duplicate key');
        expect(answer.modified).toBe(1);

        // one on its own: whether it changed is known
        expect(
            (await upsertMongoDb({ ...base, signal: signal(), upserts: [{ filter: { code: 'B' }, document: { total: 20 } }] })).results[0],
        ).toEqual({
            matched: 1,
            upsertedId: null,
            modified: 0,
        });

        const docs = await rowsOf(
            aggregateMongoDb({
                ...base,
                timeoutMs: 30_000,
                signal: signal(),
                pipeline: [{ $match: { at: { $lt: { $date: '2027-01-01T00:00:00Z' } } } }, { $project: { code: 1, total: 1, at: 1 } }],
            }),
        );
        expect(docs).toEqual([{ _id: '64f1a2b3c4d5e6f708091a2b', code: 'A', total: 10, at: '2026-11-04T12:00:00.000Z' }]);
        const b = await rowsOf(aggregateMongoDb({ ...base, timeoutMs: 30_000, signal: signal(), pipeline: [{ $match: { code: 'B' } }] }));
        // a new document's ObjectId: its hex text
        expect(b[0]!._id).toMatch(/^[0-9a-f]{24}$/);
    });

    test('a delete counts only (test run) or deletes; the filter in Extended JSON', async () => {
        const filter = { at: { $gte: { $date: '2026-01-01T00:00:00Z' } } };
        expect(await deleteMongoDb({ ...base, filter, countOnly: true, signal: signal() })).toBe(1);
        expect(await deleteMongoDb({ ...base, filter, signal: signal() })).toBe(1);
        expect(await deleteMongoDb({ ...base, filter, countOnly: true, signal: signal() })).toBe(0);
    });

    test('through the engine: a MongoDB Pipeline with its connection string secret, per envelope; the secret never in the record', async () => {
        const flow: ExecutableFlow = {
            project: 'Test',
            flow: 'Mongo',
            parameters: [],
            nodes: [
                { id: 'start', type: 'start', label: 'Start', config: {} },
                {
                    id: 'm',
                    type: 'mongodb-pipeline',
                    label: 'Orders',
                    override: true,
                    config: {
                        connectionString: 'MONGO',
                        database: 'shop',
                        collection: 'orders',
                        pipeline: "[{ $match: { code: 'B' } }, { $project: { _id: 0, code: 1, total: 1 } }]",
                    },
                },
                { id: 'end', type: 'end', label: 'End', config: {} },
            ],
            edges: [
                { source: 'start', sourcePort: 'out-0', target: 'm', targetPort: 'in-0' },
                { source: 'm', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
            ],
        };
        const record = await flowRunner(flow, {
            mode: 'validation',
            id: 'mongo-real',
            evaluate,
            documentQueries: { mongodb: aggregateMongoDb },
            secrets: { MONGO: connection },
        });
        expect(record.status).toBe('completed');
        expect(record.components.find(c => c.nodeId === 'm')!.outputSample['out-0']).toEqual([{ code: 'B', total: 20 }]);
        expect(JSON.stringify(record)).not.toContain(connection);
    });
});
