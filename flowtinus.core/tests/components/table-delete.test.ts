import { expect, test } from 'bun:test';
import { COMPONENTS, flowRunner } from '../../src/index';
import type { ExecutableFlow, RowWrite } from '../../src/index';
import { evaluate } from '../helpers';

/* SQL Server Delete and Redshift Delete (table-write.ts, mode delete): every column is a Match on condition. */

const columns = [{ column: 'Id', value: '$id', expression: true }];

test('the Match on columns are required, with valid names; no Match on list of their own, no Expected values', () => {
    for (const type of ['sqlserver-delete', 'redshift-delete']) {
        const component = COMPONENTS[type]!;
        expect(component.validate({ connection: 'db', table: 'dbo.Ticket', columns })).toEqual([]);
        expect(component.validate({ connection: 'db', table: 'dbo.Ticket', columns: [] })).toContain(
            'has no Match on column (what finds the rows to delete).',
        );
        expect(
            component.validate({ connection: 'db', table: 'dbo.Ticket', columns: [{ column: 'a b', value: '1', expression: false }] }),
        ).toContain('column "a b" is not a valid name (letters, digits, _ and $).');
        expect(component.validate({ connection: 'db', table: 'x; DROP TABLE y', columns })[0]).toContain('not a valid name');
        const keys = (component.settings ?? []).map(s => s.key);
        expect(keys).toContain('ifNotFound');
        expect(keys).not.toContain('match');
        expect(keys).not.toContain('conditions');
        expect(component.sideEffects).toBe(true);
    }
});

const flow = (type: string, config: Record<string, unknown> = {}): ExecutableFlow => ({
    project: 'Test',
    flow: 'Delete',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: {} },
        { id: 'grid', type: 'datagrid', label: 'Ids', config: { columns: [{ name: 'id', type: 'number' }], rows: [['1'], ['2'], ['3']] } },
        { id: 'd', type, label: 'Delete', config: { connection: 'db', table: 'dbo.Ticket', columns, batchSize: 2, ...config } },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'grid', targetPort: 'in-0' },
        { source: 'grid', sourcePort: 'out-0', target: 'd', targetPort: 'in-0' },
        { source: 'd', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

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

test('SQL Server Delete: the batches go to the driver as deletes; each envelope goes on with how many rows it deleted, or notFound', async () => {
    const writes: Omit<RowWrite, 'signal' | 'connection'>[] = [];
    const run = await flowRunner(flow('sqlserver-delete'), {
        mode: 'execution',
        id: 'd',
        evaluate,
        secrets: { PW: 'pw' },
        connections,
        databaseWrites: {
            sqlserver: async ({ signal: _signal, connection: _connection, ...write }) => {
                writes.push(write);
                return {
                    results: write.rows.map(row => (row[0] === 2 ? 'notFound' : 'deleted')),
                    rows: write.rows.map(row => (row[0] === 2 ? 0 : 3)),
                };
            },
        },
    });
    expect(run.status).toBe('completed');
    expect(writes).toEqual([
        { table: 'dbo.Ticket', columns: ['Id'], rows: [[1], [2]], mode: 'delete', timeoutMs: 300_000 },
        { table: 'dbo.Ticket', columns: ['Id'], rows: [[3]], mode: 'delete', timeoutMs: 300_000 },
    ]);
    expect(run.components.find(c => c.nodeId === 'd')!.outputSample['out-0']!.map(d => d.sqlserver)).toEqual([
        { action: 'deleted', rows: 3 },
        { action: 'notFound', rows: 0 },
        { action: 'deleted', rows: 3 },
    ]);
});

test('Redshift Delete: same, in its output key; If no row matches on Error sends the envelope to the On error policy', async () => {
    const run = await flowRunner(
        flow('redshift-delete', { connection: 'dw', table: 'sales.tickets', ifNotFound: 'error', onError: 'continue' }),
        {
            mode: 'execution',
            id: 'r',
            evaluate,
            secrets: { PW: 'pw' },
            connections,
            databaseWrites: {
                redshift: async write => {
                    expect(write.mode).toBe('delete');
                    expect(write.match).toBeUndefined();
                    return {
                        results: write.rows.map(row => (row[0] === 2 ? 'notFound' : 'deleted')),
                        rows: write.rows.map(row => (row[0] === 2 ? 0 : 1)),
                    };
                },
            },
        },
    );
    const node = run.components.find(c => c.nodeId === 'd')!;
    expect(node.outputSample['out-0']!.map(d => d.redshift)).toEqual([
        { action: 'deleted', rows: 1 },
        undefined,
        { action: 'deleted', rows: 1 },
    ]);
    expect(node.logs.some(l => l.level === 'error' && l.message.includes('No row of sales.tickets matched: nothing was deleted.'))).toBe(
        true,
    );
});

test('a Match on value that is null or undefined is an error for that envelope, never sent to the driver', async () => {
    const sent: unknown[][] = [];
    const run = await flowRunner(
        flow('sqlserver-delete', { columns: [{ column: 'Id', value: '$id === 2 ? null : $id', expression: true }], onError: 'continue' }),
        {
            mode: 'execution',
            id: 'n',
            evaluate,
            secrets: { PW: 'pw' },
            connections,
            databaseWrites: {
                sqlserver: async write => {
                    sent.push(...write.rows);
                    return { results: write.rows.map(() => 'deleted'), rows: write.rows.map(() => 1) };
                },
            },
        },
    );
    expect(sent).toEqual([[1], [3]]);
    const node = run.components.find(c => c.nodeId === 'd')!;
    expect(node.logs.some(l => l.level === 'error' && l.message.includes('Match on value for "Id" is null: nothing was deleted.'))).toBe(
        true,
    );
});

test('a test run deletes nothing: the log says what would be deleted', async () => {
    let called = false;
    const run = await flowRunner(flow('sqlserver-delete'), {
        mode: 'validation',
        id: 't',
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
    const node = run.components.find(c => c.nodeId === 'd')!;
    expect(node.outputSample['out-0']!.map(d => d.sqlserver)).toEqual([{ notSent: true }, { notSent: true }, { notSent: true }]);
    expect(node.logs.some(l => l.message.startsWith('Test run: 2 delete(s) (match on Id) from dbo.Ticket not sent.'))).toBe(true);
    expect(node.logs.some(l => l.message === 'Would delete from dbo.Ticket: {"Id":1}')).toBe(true);
});
