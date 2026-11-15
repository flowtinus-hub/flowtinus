import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { GenericContainer, Wait } from 'testcontainers';
import { closeSqlServerPools, querySqlServer } from '#shared/runner/sqlserver-driver';
import { writeSqlServer } from '#shared/runner/sqlserver-write-driver';

setDefaultTimeout(180_000);

const password = 'Df-test-Passw0rd!';
const sql = await new GenericContainer('mcr.microsoft.com/mssql/server:2022-latest')
    .withEnvironment({ ACCEPT_EULA: 'Y', MSSQL_SA_PASSWORD: password })
    .withExposedPorts(1433)
    .withWaitStrategy(Wait.forLogMessage(/SQL Server is now ready for client connections/))
    .withStartupTimeout(150_000)
    .start()
    .catch(() => null);
const connection = `Server=${sql?.getHost()},${sql?.getMappedPort(1433)};Database=master;User Id=sa;Password=${password};Encrypt=false;TrustServerCertificate=true`;
const signal = () => new AbortController().signal;
const query = async (text: string) => {
    const rows = [];
    for await (const row of querySqlServer({ connection, sql: text, parameters: {}, timeoutMs: 30_000, signal: signal() })) {
        rows.push(row);
    }
    return rows;
};

beforeAll(async () => {
    if (!sql) {
        return;
    }
    let last: unknown;
    for (let attempt = 0; attempt < 60; attempt++) {
        try {
            await query('SELECT 1 AS ok');
            return;
        } catch (error) {
            last = error;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    throw last;
});

afterAll(async () => {
    await closeSqlServerPools();
    await sql?.stop();
});

test.skipIf(!sql)('conditional updates atomically acquire one lock, including null expected values', async () => {
    await query('CREATE TABLE dbo.CasTest (Id int PRIMARY KEY, Version int NOT NULL, Owner nvarchar(50) NULL)');
    await query('INSERT INTO dbo.CasTest VALUES (1, 0, NULL)');
    const update = (owner: string) =>
        writeSqlServer({
            connection,
            table: 'dbo.CasTest',
            columns: ['Id', 'Version', 'Owner'],
            rows: [[1, 1, owner]],
            match: ['Id'],
            conditions: { columns: ['Version', 'Owner'], rows: [[0, null]] },
            mode: 'update',
            timeoutMs: 30_000,
            signal: signal(),
        });
    const [first, second] = await Promise.all([update('one'), update('two')]);
    expect([first.results[0], second.results[0]].sort()).toEqual(['notFound', 'updated']);
    const rows = await query('SELECT Version, Owner FROM dbo.CasTest WHERE Id = 1');
    expect(rows[0]!.Version).toBe(1);
    expect(rows[0]!.Owner === 'one' || rows[0]!.Owner === 'two').toBe(true);
});
