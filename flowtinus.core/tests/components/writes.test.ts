import { expect, test } from 'bun:test';
import { flowRunner } from '../../src/index';
import type { ComponentRun, ExecutableFlow, RowWrite, RunOptions } from '../../src/index';
import { evaluate } from '../helpers';

/*
 * ComponentRun.writes (what a database component wrote for real, per table) and the write components' last log line,
 * per table.
 */

const dw = {
    dw: { name: 'DW', type: 'redshift', config: { host: 'dw.example.com', port: '5439', database: 'sales', user: 'w', password: 'PW' } },
};

/** Start (input) → one component → End */
const flow = (type: string, config: Record<string, unknown>): ExecutableFlow => ({
    project: 'Test',
    flow: 'Writes',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
        { id: 'w', type, label: 'Write', config: { onError: 'continue', ...config } },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'w', targetPort: 'in-0' },
        { source: 'w', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

const node = (record: { components: ComponentRun[] }) => record.components.find(c => c.nodeId === 'w')!;
const messages = (c: ComponentRun) => c.logs.map(l => l.message.replace(/in \d+ ms/, 'in N ms'));

/** an Insert whose table comes from each envelope */
const stage = {
    connection: 'dw',
    table: { value: '$table', expression: true },
    columns: [{ column: 'id', value: '$id', expression: true }],
    batchSize: 10,
};

test('an Insert with the table by expression: writes and the last log line per table, a failed batch counted on its table', async () => {
    const writes: Omit<RowWrite, 'signal' | 'connection'>[] = [];
    const options: RunOptions = {
        mode: 'execution',
        id: 'w1',
        evaluate,
        secrets: { PW: 'pw' },
        connections: dw,
        input: [
            { table: 'df.briefs__df_stage', id: 1 },
            { table: 'df.briefs__df_stage', id: 2 },
            { table: 'df.brief_pauses__df_stage', id: 3 },
            { table: 'bad name', id: 4 },
            { table: 'df.briefs__df_stage', id: 5 },
        ],
        databaseWrites: {
            redshift: async ({ signal: _s, connection: _c, ...write }) => {
                writes.push(write);
                if (write.table === 'df.brief_pauses__df_stage') {
                    throw new Error('value too long for type character varying(10)');
                }
                return { results: write.rows.map(() => 'inserted') };
            },
        },
    };
    const run = await flowRunner(flow('redshift-insert', stage), options);
    const w = node(run);
    // a change of table closes the batch: three batches, one table each
    expect(writes.map(x => [x.table, x.rows])).toEqual([
        ['df.briefs__df_stage', [[1], [2]]],
        ['df.brief_pauses__df_stage', [[3]]],
        ['df.briefs__df_stage', [[5]]],
    ]);
    expect(w.writes).toEqual({
        'df.briefs__df_stage': { inserted: 3, updated: 0, deleted: 0, affected: 3, batches: 2, failed: 0 },
        'df.brief_pauses__df_stage': { inserted: 0, updated: 0, deleted: 0, affected: 0, batches: 0, failed: 1 },
    });
    const logs = messages(w);
    expect(logs).toContain('Batch 1 (df.briefs__df_stage): 2 row(s) in N ms (2 inserted).');
    expect(logs).toContain('Batch 2 (df.briefs__df_stage): 1 row(s) in N ms (1 inserted).');
    expect(logs.at(-1)).toBe(
        'df.briefs__df_stage: 3 inserted; df.brief_pauses__df_stage: 0 inserted, 1 failed; 1 failed before its table was known (the table expression).',
    );
});

test('an Update counts the rows each envelope changed as affected; no row matched on Error is a failed one', async () => {
    const run = await flowRunner(
        flow('sqlserver-update', {
            connection: 'db',
            table: 'dbo.Ticket',
            columns: [
                { column: 'Id', value: '$id', expression: true },
                { column: 'Status', value: 'closed', expression: false },
            ],
            match: ['Id'],
            ifNotFound: 'error',
        }),
        {
            mode: 'execution',
            id: 'w2',
            evaluate,
            secrets: { PW: 'pw' },
            connections: {
                db: {
                    name: 'DB',
                    type: 'sqlserver',
                    config: { host: 'db.example.com', port: '1433', database: 'app', user: 'u', password: 'PW' },
                },
            },
            input: [{ id: 1 }, { id: 2 }, { id: 3 }],
            databaseWrites: {
                sqlserver: async ({ rows }) => ({
                    results: rows.map(([id]) => (id === 3 ? 'notFound' : 'updated')),
                    rows: rows.map(([id]) => (id === 1 ? 2 : id === 2 ? 1 : 0)),
                }),
            },
        },
    );
    const w = node(run);
    expect(w.writes).toEqual({ 'dbo.Ticket': { inserted: 0, updated: 2, deleted: 0, affected: 3, batches: 1, failed: 1 } });
    expect(messages(w).at(-1)).toBe('dbo.Ticket: 2 updated, 1 not found, 1 failed.');
});

test('a test run writes nothing: no writes; the last log line says what was prepared per table, none sent', async () => {
    const run = await flowRunner(flow('redshift-insert', stage), {
        mode: 'validation',
        id: 'w3',
        evaluate,
        secrets: { PW: 'pw' },
        connections: dw,
        input: [
            { table: 'a.t1', id: 1 },
            { table: 'a.t2', id: 2 },
        ],
        databaseWrites: {
            redshift: async () => {
                throw new Error('a test run sends nothing');
            },
        },
    });
    const w = node(run);
    expect(w.writes).toBeUndefined();
    expect(messages(w)).toContain('a.t1: 1 row(s) prepared; a.t2: 1 row(s) prepared; none sent.');
});

test('an Execute counts its rows affected under sql, one batch per run; an envelope that did not run is a failed one', async () => {
    const run = await flowRunner(
        flow('redshift-execute', {
            connection: 'dw',
            sql: 'DELETE FROM {{t}} WHERE id = @id',
            parameters: [
                { name: 't', value: '$t', expression: true },
                { name: 'id', value: '$id', expression: true },
            ],
        }),
        {
            mode: 'execution',
            id: 'w4',
            evaluate,
            secrets: { PW: 'pw' },
            connections: dw,
            input: [
                { t: 'a.x', id: 1 },
                { t: 'a.x', id: 2 },
                { t: 'not ok!', id: 3 },
            ],
            databaseExecutes: {
                redshift: async ({ parameters }) => ({ rowsAffected: Number(parameters.id), rows: [], transaction: 'committed' }),
            },
        },
    );
    expect(node(run).writes).toEqual({ sql: { inserted: 0, updated: 0, deleted: 0, affected: 3, batches: 2, failed: 1 } });
});

test('MongoDB Upsert and Delete count per collection (database.collection when the component names the database)', async () => {
    const mongo = {
        m: { name: 'M', type: 'mongodb', config: { connectionString: 'MONGO', database: 'crm' } },
    };
    const upsert = await flowRunner(
        flow('mongodb-upsert', {
            connection: 'm',
            database: { value: 'crm', expression: false },
            collection: { value: 'people', expression: false },
            filter: [{ field: '_id', value: '$id', expression: true }],
        }),
        {
            mode: 'execution',
            id: 'w5',
            evaluate,
            secrets: { MONGO: 'mongodb://x' },
            connections: mongo,
            input: [{ id: 1 }, { id: 2 }, { id: 3 }],
            documentStores: {
                mongodb: async batch => ({
                    results: batch.upserts.map(u =>
                        u.filter._id === 1 ? { matched: 0, upsertedId: 'new' } : { matched: 1, upsertedId: null },
                    ),
                    modified: 1,
                }),
            },
        },
    );
    expect(node(upsert).writes).toEqual({ 'crm.people': { inserted: 1, updated: 1, deleted: 0, affected: 2, batches: 1, failed: 0 } });

    const removed = await flowRunner(
        flow('mongodb-delete', { connection: 'm', collection: { value: 'people', expression: false }, filter: '{ _id: $id }' }),
        {
            mode: 'execution',
            id: 'w6',
            evaluate,
            secrets: { MONGO: 'mongodb://x' },
            connections: mongo,
            input: [{ id: 1 }, { id: 2 }],
            documentDeletes: { mongodb: async ({ filter }) => (filter._id === 1 ? 1 : 0) },
        },
    );
    expect(node(removed).writes).toEqual({ people: { inserted: 0, updated: 0, deleted: 1, affected: 1, batches: 2, failed: 0 } });
});
