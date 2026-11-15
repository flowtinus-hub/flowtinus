import { expect, test } from 'bun:test';
import { COMPONENTS, connectionString, flowRunner, positionalSql, redshiftReadOnlyIssue, redshiftUsedParameters, resolveConnection } from '../../src/index';
import type { ExecutableFlow } from '../../src/index';
import { evaluate } from '../helpers';

test('Redshift Query only accepts one read-only statement', () => {
    for (const sql of [
        'SELECT * FROM sales.orders WHERE id > @last',
        'with x as (select 1 as a) select a from x;',
        'SELECT \'INSERT INTO x\' AS text -- DELETE\nFROM "update"',
        "SELECT CASE WHEN a > 1 THEN 'x' END AS b FROM t",
        "SELECT E'it\\'s; DELETE' AS a, $$; DROP$$ AS b FROM t",
        '/* /* nested */ DELETE */ SELECT 1',
    ]) {
        expect(redshiftReadOnlyIssue(sql)).toBeNull();
    }
    const bad: [string, string][] = [
        ['DELETE FROM t', 'SELECT or WITH'],
        ['SELECT * INTO copy FROM t', 'INTO'],
        ['SELECT 1; DROP TABLE t', 'more than one statement'],
        ['WITH x AS (SELECT 1 a) UPDATE t SET a = 1', 'UPDATE'],
        ["SELECT 1 FROM t WHERE a = 1 UNLOAD ('select 1') TO 's3://x'", 'UNLOAD'],
        ["SELECT '--', 1; DELETE FROM t", 'more than one statement'],
        ['', 'has no query'],
    ];
    for (const [sql, excerpt] of bad) {
        expect(redshiftReadOnlyIssue(sql)).toContain(excerpt);
    }
});

test('@names become $1, $2... in order of first use, outside strings and comments, whatever the case', () => {
    expect(redshiftUsedParameters("SELECT @a, @b, @A, '@c', a @> b -- @d")).toEqual(['a', 'b', 'A']);
    expect(positionalSql("SELECT * FROM t WHERE a = @a AND b IN (@B, @b) AND c = '@a' AND d = @a")).toEqual({
        text: "SELECT * FROM t WHERE a = $1 AND b IN ($2, $2) AND c = '@a' AND d = $1",
        names: ['a', 'B'],
    });
    expect(positionalSql('SELECT 1')).toEqual({ text: 'SELECT 1', names: [] });
});

test('validate: the connection, read-only, the parameters it uses', () => {
    const redshift = COMPONENTS.redshift!;
    expect(redshift.validate({ connection: 'db', sql: 'SELECT * FROM t WHERE id = @id', parameters: [] })).toEqual([
        'uses @id, which is not in the parameters.',
    ]);
    expect(redshift.validate({ connection: 'db', sql: 'SELECT 1', parameters: [{ name: 'a' }, { name: 'A' }] })).toEqual([
        'has the parameter "@A" more than once.',
    ]);
    expect(redshift.validate({ sql: 'SELECT 1' })[0]).toContain('has no connection');
});

test('the connection string: a postgres:// URL, SSL required unless turned off, the password from its secret', () => {
    const profile = {
        name: 'DW',
        type: 'redshift',
        config: { host: 'dw.example.com', port: '5439', database: 'sales', user: 'reader', password: 'DW_PASSWORD', ssl: 'on' },
    };
    const resolved = resolveConnection('redshift', { profile: 'dw' }, { dw: profile }, { DW_PASSWORD: 'p@ss/word' });
    expect(connectionString(resolved)).toBe('postgres://reader:p%40ss%2Fword@dw.example.com:5439/sales?sslmode=require');
    const local = resolveConnection(
        'redshift',
        { profile: 'dw' },
        { dw: { ...profile, config: { ...profile.config, ssl: 'off' } } },
        { DW_PASSWORD: 'x' },
    );
    expect(connectionString(local)).toEndWith('?sslmode=disable');
});

test('Redshift Query yields one envelope per row and sends the evaluated parameters', async () => {
    const queries: unknown[] = [];
    const queryRedshift = async function* (q: { connection: string; sql: string; parameters: Record<string, unknown> }) {
        queries.push({ connection: q.connection, sql: q.sql, parameters: q.parameters });
        yield { email: 'ana@example.com' };
        yield { email: 'bia@example.com' };
    };
    const flow: ExecutableFlow = {
        project: 'Test',
        flow: 'Redshift',
        parameters: [{ name: 'region', type: 'text', default: 'south' }],
        nodes: [
            { id: 'start', type: 'start', label: 'Start', config: {} },
            {
                id: 'r',
                type: 'redshift',
                label: 'Customers',
                override: true,
                config: {
                    connection: 'dw',
                    sql: 'SELECT email FROM sales.customers WHERE region = @region',
                    parameters: [{ name: 'region', value: '$PARAMETERS.region', expression: true }],
                },
            },
            { id: 'end', type: 'end', label: 'End', config: {} },
        ],
        edges: [
            { source: 'start', sourcePort: 'out-0', target: 'r', targetPort: 'in-0' },
            { source: 'r', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        ],
    };
    const run = await flowRunner(flow, {
        mode: 'execution',
        id: 'rs',
        evaluate,
        databases: { redshift: queryRedshift },
        secrets: { DW_PASSWORD: 'pw' },
        connections: {
            dw: {
                name: 'DW',
                type: 'redshift',
                config: { host: 'dw.example.com', port: '5439', database: 'sales', user: 'reader', password: 'DW_PASSWORD' },
            },
        },
    });
    expect(run.status).toBe('completed');
    expect(queries).toEqual([
        {
            connection: 'postgres://reader:pw@dw.example.com:5439/sales?sslmode=require',
            sql: 'SELECT email FROM sales.customers WHERE region = @region',
            parameters: { region: 'south' },
        },
    ]);
    expect(run.components.find(c => c.nodeId === 'r')!.outputSample['out-0']).toEqual([
        { email: 'ana@example.com' },
        { email: 'bia@example.com' },
    ]);
});
