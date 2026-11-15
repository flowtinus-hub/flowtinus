import { expect, test } from 'bun:test';
import { COMPONENTS, flowRunner, splitStatements } from '../../src/index';
import type { ExecutableFlow, SqlExecute } from '../../src/index';
import { evaluate } from '../helpers';

const connections = {
    db: {
        name: 'ERP',
        type: 'sqlserver',
        config: {
            host: 'db.example.com',
            port: '1433',
            database: 'crm',
            user: 'w',
            password: 'PW',
            encrypt: 'on',
            trustServerCertificate: 'off',
        },
    },
    dw: { name: 'DW', type: 'redshift', config: { host: 'dw.example.com', port: '5439', database: 'sales', user: 'w', password: 'PW' } },
};

const flow = (type: string, config: Record<string, unknown>): ExecutableFlow => ({
    project: 'Test',
    flow: 'Execute',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
        { id: 'x', type, label: 'Execute', config },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'x', targetPort: 'in-0' },
        { source: 'x', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

const replace = {
    connection: 'dw',
    sql: 'DELETE FROM {{schema}}.projects WHERE brief_id = @briefId;\nINSERT INTO {{schema}}.projects (brief_id, name) VALUES (@briefId, @name);',
    parameters: [
        { name: 'schema', value: '$tenant', expression: true },
        { name: 'briefId', value: '$id', expression: true },
        { name: 'name', value: '$name', expression: true },
    ],
};

test('validation: SQL required; the @names (Redshift) and {{names}} must be parameters; any SQL goes', () => {
    expect(COMPONENTS['redshift-execute']!.validate(replace)).toEqual([]);
    expect(COMPONENTS['redshift-execute']!.validate({ connection: 'dw', sql: ' ' })).toContain('has no SQL.');
    expect(COMPONENTS['redshift-execute']!.validate({ connection: 'dw', sql: 'DROP TABLE {{t}} WHERE x = @x' })).toEqual([
        'uses @x, which is not in the parameters.',
        'uses {{t}}, which is not in the parameters.',
    ]);
    // SQL Server's own variables are @names too
    expect(COMPONENTS['sqlserver-execute']!.validate({ connection: 'db', sql: 'DECLARE @n int = 1; EXEC dbo.Recalc @n;' })).toEqual([]);
    expect(splitStatements("SELECT ';' AS a; -- ;\nUPDATE t SET x = 1;;  ", 'redshift')).toEqual([
        "SELECT ';' AS a",
        '-- ;\nUPDATE t SET x = 1',
    ]);
});

test('Redshift Execute: once per envelope, names pasted, values as parameters; the answer in the output key', async () => {
    const sent: Omit<SqlExecute, 'signal' | 'connection'>[] = [];
    const run = await flowRunner(flow('redshift-execute', replace), {
        mode: 'execution',
        id: 'x',
        evaluate,
        input: [
            { tenant: 'te1', id: 7, name: 'A' },
            { tenant: 'te1"; --', id: 8, name: 'B' },
        ],
        secrets: { PW: 'pw' },
        connections,
        databaseExecutes: {
            redshift: async ({ signal: _s, connection: _c, ...execute }) => {
                sent.push(execute);
                return { rowsAffected: 3, rows: [], transaction: 'committed' };
            },
        },
    });
    expect(sent).toEqual([
        {
            sql: 'DELETE FROM te1.projects WHERE brief_id = @briefId;\nINSERT INTO te1.projects (brief_id, name) VALUES (@briefId, @name);',
            parameters: { schema: 'te1', briefId: 7, name: 'A' },
            atEnd: 'commit',
            timeoutMs: 300_000,
        },
    ]);
    const node = run.components.find(c => c.nodeId === 'x')!;
    expect(node.outputSample['out-0']![0]!.redshift).toEqual({ rowsAffected: 3, rows: [], transaction: 'committed' });
    expect(node.logs.some(l => l.level === 'error' && l.message.includes('is not a valid name'))).toBe(true);
});

test('SQL Server Execute: At the end Rollback is passed on; a driver error goes to the On error policy; a test run runs nothing', async () => {
    const config = {
        connection: 'db',
        sql: 'UPDATE dbo.T SET X = @x',
        parameters: [{ name: 'x', value: '$x', expression: true }],
        atEnd: 'rollback',
        onError: 'continue',
    };
    const ends: string[] = [];
    const run = await flowRunner(flow('sqlserver-execute', config), {
        mode: 'execution',
        id: 's',
        evaluate,
        input: [{ x: 1 }, { x: 2 }],
        secrets: { PW: 'pw' },
        connections,
        databaseExecutes: {
            sqlserver: async execute => {
                ends.push(execute.atEnd);
                if (execute.parameters.x === 2) {
                    throw new Error('Deadlock');
                }
                return { rowsAffected: 1, rows: [{ ok: 1 }], transaction: 'rolledBack' };
            },
        },
    });
    expect(ends).toEqual(['rollback', 'rollback']);
    const node = run.components.find(c => c.nodeId === 'x')!;
    expect(node.outputSample['out-0']!.map(d => d.sqlserver)).toEqual([
        { rowsAffected: 1, rows: [{ ok: 1 }], transaction: 'rolledBack' },
        undefined,
    ]);
    expect(node.logs.some(l => l.level === 'error' && l.message.includes('Deadlock'))).toBe(true);

    let called = false;
    const test = await flowRunner(flow('sqlserver-execute', config), {
        mode: 'validation',
        id: 't',
        evaluate,
        input: [{ x: 1 }],
        secrets: { PW: 'pw' },
        connections,
        databaseExecutes: {
            sqlserver: async () => {
                called = true;
                return { rowsAffected: 0, rows: [], transaction: 'committed' };
            },
        },
    });
    expect(called).toBe(false);
    const tested = test.components.find(c => c.nodeId === 'x')!;
    expect(tested.outputSample['out-0']!.map(d => d.sqlserver)).toEqual([{ notSent: true }]);
    expect(tested.logs.some(l => l.message === 'Test run: SQL not run (it would rollback at the end): UPDATE dbo.T SET X = @x')).toBe(true);
});
