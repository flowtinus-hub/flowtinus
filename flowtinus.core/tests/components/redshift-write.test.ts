import { expect, test } from 'bun:test';
import { COMPONENTS, flowRunner, tableNameIssue } from '../../src/index';
import type { ExecutableFlow, RowWrite } from '../../src/index';
import { evaluate } from '../helpers';

const columns = [
    { column: 'email', value: '$email', expression: true },
    { column: 'tags', value: '$tags', expression: true },
];

test('the table and column names, and the upsert’s Match on', () => {
    expect(tableNameIssue('sales.customers')).toBeNull();
    expect(tableNameIssue('customers')).toBeNull();
    expect(tableNameIssue('a.b.c')).toContain('not a valid name');
    expect(tableNameIssue('x; DROP TABLE y')).toContain('not a valid name');

    const insert = COMPONENTS['redshift-insert']!;
    expect(insert.validate({ connection: 'dw', table: 't', columns })).toEqual([]);
    expect(
        insert.validate({
            connection: 'dw',
            table: 't',
            columns: [
                { column: 'a b', value: '1', expression: false },
                { column: 'A', value: '', expression: true },
                { column: 'a', value: '2', expression: false },
            ],
        }),
    ).toEqual([
        'column "a b" is not a valid name (letters, digits, _ and $).',
        'column "A" is an expression, but empty.',
        'has the column "a" more than once.',
    ]);

    const upsert = COMPONENTS['redshift-upsert']!;
    expect(upsert.validate({ connection: 'dw', table: 't', columns, match: ['email'] })).toEqual([]);
    expect(upsert.validate({ connection: 'dw', table: 't', columns })).toContain('has no Match on column (what finds the row to update).');
    expect(upsert.validate({ connection: 'dw', table: 't', columns, match: ['id'] })).toContain(
        'matches on "id", which is not one of its columns.',
    );
    expect(upsert.validate({ connection: 'dw', table: 't', columns, match: ['email', 'tags'] })[0]).toContain('nothing to update');
});

const flow = (type: string, config: Record<string, unknown>): ExecutableFlow => ({
    project: 'Test',
    flow: 'Write',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: {} },
        {
            id: 'grid',
            type: 'datagrid',
            label: 'Rows',
            config: { columns: [{ name: 'email', type: 'text' }], rows: [['a@x.com'], ['b@x.com'], ['a@x.com']] },
        },
        { id: 'w', type, label: 'Write', config: { connection: 'dw', table: 'sales.customers', columns, batchSize: 2, ...config } },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'grid', targetPort: 'in-0' },
        { source: 'grid', sourcePort: 'out-0', target: 'w', targetPort: 'in-0' },
        { source: 'w', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

const connections = {
    dw: { name: 'DW', type: 'redshift', config: { host: 'dw.example.com', port: '5439', database: 'sales', user: 'w', password: 'PW' } },
};

test('the rows go to the driver in batches; each envelope goes on with what happened to its row', async () => {
    const writes: Omit<RowWrite, 'signal'>[] = [];
    const run = await flowRunner(flow('redshift-upsert', { match: ['email'] }), {
        mode: 'execution',
        id: 'w',
        evaluate,
        secrets: { PW: 'pw' },
        connections,
        databaseWrites: {
            redshift: async ({ signal: _signal, ...write }) => {
                writes.push(write);
                return { results: write.rows.map((_, i) => (i === 0 ? 'updated' : 'inserted')) };
            },
        },
    });
    expect(run.status).toBe('completed');
    expect(writes.map(w => w.rows)).toEqual([
        [
            ['a@x.com', null],
            ['b@x.com', null],
        ],
        [['a@x.com', null]],
    ]);
    expect(writes[0]).toMatchObject({
        table: 'sales.customers',
        columns: ['email', 'tags'],
        match: ['email'],
        connection: 'postgres://w:pw@dw.example.com:5439/sales?sslmode=require',
    });
    expect(run.components.find(c => c.nodeId === 'w')!.outputSample['out-0']!.map(d => d.redshift)).toEqual([
        { action: 'updated' },
        { action: 'inserted' },
        { action: 'updated' },
    ]);
});

test('a list or an object goes as JSON text; a batch that fails sends its envelopes to the error policy', async () => {
    const seen: unknown[][] = [];
    const run = await flowRunner(
        flow('redshift-insert', {
            columns: [{ column: 'tags', value: "['a', 'b']", expression: true }],
            batchSize: 10,
            onError: 'continue',
        }),
        {
            mode: 'execution',
            id: 'w2',
            evaluate,
            secrets: { PW: 'pw' },
            connections,
            databaseWrites: {
                redshift: async write => {
                    seen.push(...write.rows);
                    throw new Error('permission denied for relation customers');
                },
            },
        },
    );
    expect(seen[0]).toEqual(['["a","b"]']);
    const node = run.components.find(c => c.nodeId === 'w')!;
    expect(node.logs.filter(l => l.level === 'error')).toHaveLength(3);
});

test('a test run writes nothing: the log says what would be sent, the envelopes go on as not sent', async () => {
    let called = false;
    const run = await flowRunner(flow('redshift-insert', {}), {
        mode: 'validation',
        id: 'w3',
        evaluate,
        secrets: { PW: 'pw' },
        connections,
        databaseWrites: {
            redshift: async () => {
                called = true;
                return { results: [] };
            },
        },
    });
    expect(called).toBe(false);
    const node = run.components.find(c => c.nodeId === 'w')!;
    expect(node.outputSample['out-0']!.map(d => d.redshift)).toEqual([{ notSent: true }, { notSent: true }, { notSent: true }]);
    expect(node.logs.some(l => l.message.startsWith('Test run: 2 insert(s) into sales.customers not sent.'))).toBe(true);
    expect(node.logs.some(l => l.message === 'Would write into sales.customers: {"email":"a@x.com","tags":null}')).toBe(true);
});
