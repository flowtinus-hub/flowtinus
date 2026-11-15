import { expect, test } from 'bun:test';
import { COMPONENTS, flowRunner } from '../../src/index';
import type { ExecutableFlow, RowWrite } from '../../src/index';
import { evaluate } from '../helpers';

const columns = [
    { column: 'Id', value: '$id', expression: true },
    { column: 'Status', value: 'closed', expression: false },
];

test('SQL Server Update: Match on is required and among the columns; something must be left to set', () => {
    const update = COMPONENTS['sqlserver-update']!;
    expect(update.validate({ connection: 'db', table: 'dbo.Ticket', columns, match: ['Id'] })).toEqual([]);
    expect(update.validate({ connection: 'db', table: 'dbo.Ticket', columns })).toContain(
        'has no Match on column (what finds the rows to update).',
    );
    expect(update.validate({ connection: 'db', table: 'dbo.Ticket', columns, match: ['Id', 'Status'] })).toContain(
        'matches on every column: there is nothing to update.',
    );
    expect(update.validate({ connection: 'db', table: 'dbo.[Ticket]', columns, match: ['Id'] })[0]).toContain('not a valid name');
});

const flow: ExecutableFlow = {
    project: 'Test',
    flow: 'Update',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: {} },
        { id: 'grid', type: 'datagrid', label: 'Ids', config: { columns: [{ name: 'id', type: 'number' }], rows: [['1'], ['2']] } },
        { id: 'u', type: 'sqlserver-update', label: 'Close', config: { connection: 'db', table: 'dbo.Ticket', columns, match: ['Id'] } },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'grid', targetPort: 'in-0' },
        { source: 'grid', sourcePort: 'out-0', target: 'u', targetPort: 'in-0' },
        { source: 'u', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
};

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
};

test('each envelope goes on with how many rows it changed, or notFound; a test run sends nothing', async () => {
    const writes: Omit<RowWrite, 'signal' | 'connection'>[] = [];
    const run = await flowRunner(flow, {
        mode: 'execution',
        id: 'u',
        evaluate,
        secrets: { PW: 'pw' },
        connections,
        databaseWrites: {
            sqlserver: async ({ signal: _signal, connection: _connection, ...write }) => {
                writes.push(write);
                return { results: ['updated', 'notFound'], rows: [1, 0] };
            },
        },
    });

    expect(run.status).toBe('completed');
    expect(writes).toEqual([
        {
            table: 'dbo.Ticket',
            columns: ['Id', 'Status'],
            rows: [
                [1, 'closed'],
                [2, 'closed'],
            ],
            mode: 'update',
            match: ['Id'],
            timeoutMs: 300_000,
        },
    ]);
    expect(run.components.find(c => c.nodeId === 'u')!.outputSample['out-0']!.map(d => d.sqlserver)).toEqual([
        { action: 'updated', rows: 1 },
        { action: 'notFound', rows: 0 },
    ]);

    let called = false;
    const test = await flowRunner(flow, {
        mode: 'validation',
        id: 'u2',
        evaluate,
        secrets: { PW: 'pw' },
        connections,
        databaseWrites: {
            sqlserver: async () => {
                called = true;
                return { results: [] };
            },
        },
    });
    expect(called).toBe(false);
    expect(
        test.components
            .find(c => c.nodeId === 'u')!
            .logs.some(l => l.message.startsWith('Test run: 2 update(s) (match on Id) into dbo.Ticket not sent.')),
    ).toBe(true);
});

test('SQL Server Update passes independent expected values for compare-and-set', async () => {
    const conditional: ExecutableFlow = {
        ...flow,
        nodes: flow.nodes.map(node =>
            node.id === 'u'
                ? {
                      ...node,
                      config: {
                          ...node.config,
                          conditions: [{ column: 'Status', value: '$id === 1 ? "open" : null', expression: true }],
                      },
                  }
                : node,
        ),
    };
    const writes: RowWrite[] = [];
    const record = await flowRunner(conditional, {
        mode: 'execution',
        id: 'cas',
        evaluate,
        secrets: { PW: 'pw' },
        connections,
        databaseWrites: {
            sqlserver: async write => {
                writes.push(write);
                return { results: ['updated', 'notFound'], rows: [1, 0] };
            },
        },
    });
    expect(record.status).toBe('completed');
    expect(writes[0]!.conditions).toEqual({ columns: ['Status'], rows: [['open'], [null]] });
    expect(
        COMPONENTS['sqlserver-update']!.validate({
            connection: 'db',
            table: 'dbo.Ticket',
            columns,
            match: ['Id'],
            conditions: [{ column: 'a.b', value: 'x', expression: false }],
        }),
    ).toContain('expected column 1 is not a valid name.');
});

test('If no row matches on Error: the envelope that found nothing goes to the On error policy', async () => {
    const strict: ExecutableFlow = {
        ...flow,
        nodes: flow.nodes.map(node =>
            node.id === 'u' ? { ...node, config: { ...node.config, ifNotFound: 'error', onError: 'continue' } } : node,
        ),
    };
    const record = await flowRunner(strict, {
        mode: 'execution',
        id: 'strict',
        evaluate,
        secrets: { PW: 'pw' },
        connections,
        databaseWrites: { sqlserver: async () => ({ results: ['updated', 'notFound'], rows: [1, 0] }) },
    });
    const node = record.components.find(c => c.nodeId === 'u')!;
    // On error Continue: the one that found nothing goes on as it came, without a result
    expect(node.outputSample['out-0']!.map(d => d.sqlserver)).toEqual([{ action: 'updated', rows: 1 }, undefined]);
    expect(node.logs.some(l => l.level === 'error' && l.message.includes('No row of dbo.Ticket matched'))).toBe(true);
});
