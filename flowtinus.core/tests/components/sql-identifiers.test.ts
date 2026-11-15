import { expect, test } from 'bun:test';
import { COMPONENTS, flowRunner } from '../../src/index';
import type { DatabaseQuery, ExecutableFlow, RowWrite, SqlExecute } from '../../src/index';
import { boundParameters, identifierIssue, identifierListIssue, usedIdentifiers, withIdentifiers } from '../../src/components/sql-identifiers';
import { evaluate } from '../helpers';

test('{{name}} is replaced by a checked name, only outside strings and comments', () => {
    const sql = "SELECT '{{schema}}' AS s, x -- {{schema}}\nFROM {{schema}}.briefs WHERE a = @a /* {{ other }} */";
    expect(usedIdentifiers(sql, 'redshift')).toEqual(['schema']);
    expect(withIdentifiers(sql, 'redshift', { Schema: 'te1', a: 1 })).toBe(
        "SELECT '{{schema}}' AS s, x -- {{schema}}\nFROM te1.briefs WHERE a = @a /* {{ other }} */",
    );
    expect(withIdentifiers('SELECT * FROM [{{t}}] JOIN {{ t }}', 'sqlserver', { t: 'dbo.Customer' })).toBe(
        'SELECT * FROM [{{t}}] JOIN dbo.Customer',
    );
    expect(() => withIdentifiers('SELECT * FROM {{t}}', 'redshift', {})).toThrow('{{t}} has no parameter.');
    expect(() => withIdentifiers('SELECT * FROM {{t}}', 'redshift', { t: 'x; DROP TABLE y' })).toThrow('is not a valid name');
    expect(identifierIssue('te0.briefs')).toBeNull();
    expect(identifierIssue('a.b.c')).toContain('not a valid name');
    expect(identifierIssue('te0"."x')).toContain('not a valid name');
    expect(identifierIssue(null)).toBe('is not text (null)');
});

test('a list of names is pasted as a, b, c: each item one simple name, an empty list an error, never inside strings or comments', () => {
    const sql = "INSERT INTO {{t}} ({{columns}}) SELECT {{ columns }} FROM s -- {{columns}}\nWHERE x = '{{columns}}' /* {{columns}} */";
    expect(withIdentifiers(sql, 'redshift', { t: 'te0.briefs', columns: ['id', ' name ', 'created_at'] })).toBe(
        "INSERT INTO te0.briefs (id, name, created_at) SELECT id, name, created_at FROM s -- {{columns}}\nWHERE x = '{{columns}}' /* {{columns}} */",
    );
    expect(withIdentifiers('SELECT {{c}} FROM [{{c}}]', 'sqlserver', { c: ['Id'] })).toBe('SELECT Id FROM [{{c}}]');
    // an item that is not one simple name: schema.name, an injection, a number, null
    expect(() => withIdentifiers('SELECT {{c}} FROM t', 'redshift', { c: ['id', 't.name'] })).toThrow(
        '{{c}} item 2 "t.name" is not a valid name (in a list, each item is one name: letters, digits, _ and $).',
    );
    expect(() => withIdentifiers('SELECT {{c}} FROM t', 'redshift', { c: ['id', 'x; DROP TABLE y'] })).toThrow('item 2');
    expect(identifierListIssue(['a', 1])).toBe('item 2 is not text (number)');
    expect(identifierListIssue([null])).toBe('item 1 is not text (null)');
    expect(() => withIdentifiers('SELECT {{c}} FROM t', 'sqlserver', { c: [] })).toThrow(
        '{{c}} is an empty list (it needs at least one name).',
    );
    // a list is not pasted where the SQL does not use it as a name: inside a string or a comment nothing is checked
    expect(withIdentifiers("SELECT '{{c}}' -- {{c}}", 'redshift', { c: [] })).toBe("SELECT '{{c}}' -- {{c}}");
    // a driver binds the pasted text, never the list; the other values as they are
    expect(boundParameters('SELECT {{c}} FROM t WHERE id = @id', 'redshift', { c: ['a', 'b'], id: [1, 2] })).toEqual({
        c: 'a, b',
        id: [1, 2],
    });
});

test('an Execute pastes a list of columns into its SQL and sends no list as a parameter', async () => {
    const executes: Omit<SqlExecute, 'signal' | 'connection'>[] = [];
    const flow: ExecutableFlow = {
        project: 'Test',
        flow: 'E',
        parameters: [],
        nodes: [
            { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
            {
                id: 'x',
                type: 'redshift-execute',
                label: 'X',
                config: {
                    connection: 'dw',
                    sql: 'INSERT INTO {{table}} ({{columns}}) SELECT {{columns}} FROM stage WHERE batch = @batch',
                    parameters: [
                        { name: 'table', value: '$table', expression: true },
                        { name: 'columns', value: '$columns', expression: true },
                        { name: 'batch', value: '$batch', expression: true },
                    ],
                    onError: 'continue',
                },
            },
            { id: 'end', type: 'end', label: 'End', config: {} },
        ],
        edges: [
            { source: 'start', sourcePort: 'out-0', target: 'x', targetPort: 'in-0' },
            { source: 'x', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        ],
    };
    const run = await flowRunner(flow, {
        mode: 'execution',
        id: 'e',
        evaluate,
        input: [
            { table: 'te0.briefs', columns: ['id', 'name'], batch: 7 },
            { table: 'te0.briefs', columns: [], batch: 8 },
        ],
        secrets: { PW: 'pw' },
        connections: {
            dw: {
                name: 'DW',
                type: 'redshift',
                config: { host: 'dw.example.com', port: '5439', database: 'sales', user: 'w', password: 'PW' },
            },
        },
        databaseExecutes: {
            redshift: async ({ signal: _s, connection: _c, ...execute }) => {
                executes.push(execute);
                return { rowsAffected: 2, rows: [], transaction: 'committed' };
            },
        },
    });
    expect(executes).toHaveLength(1);
    expect(executes[0]!.sql).toBe('INSERT INTO te0.briefs (id, name) SELECT id, name FROM stage WHERE batch = @batch');
    expect(executes[0]!.parameters).toEqual({ table: 'te0.briefs', columns: 'id, name', batch: 7 });
    const node = run.components.find(c => c.nodeId === 'x')!;
    expect(node.logs.some(l => l.level === 'error' && l.message === '{{columns}} is an empty list (it needs at least one name).')).toBe(
        true,
    );
});

test('a Query that uses {{name}} needs it in the parameters, and sends the name pasted, the values as parameters', async () => {
    expect(COMPONENTS.redshift!.validate({ connection: 'dw', sql: 'SELECT * FROM {{schema}}.briefs' })).toContain(
        'uses {{schema}}, which is not in the parameters.',
    );
    const queries: Omit<DatabaseQuery, 'signal' | 'connection'>[] = [];
    const flow: ExecutableFlow = {
        project: 'Test',
        flow: 'Q',
        parameters: [],
        nodes: [
            { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
            {
                id: 'q',
                type: 'redshift',
                label: 'Q',
                config: {
                    connection: 'dw',
                    sql: 'SELECT id FROM {{schema}}.briefs WHERE id = @id',
                    parameters: [
                        { name: 'schema', value: '$tenant', expression: true },
                        { name: 'id', value: '$id', expression: true },
                    ],
                },
            },
            { id: 'end', type: 'end', label: 'End', config: {} },
        ],
        edges: [
            { source: 'start', sourcePort: 'out-0', target: 'q', targetPort: 'in-0' },
            { source: 'q', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        ],
    };
    const run = await flowRunner(flow, {
        mode: 'execution',
        id: 'q',
        evaluate,
        input: [
            { tenant: 'te1', id: 1 },
            { tenant: 'te1; DROP TABLE x', id: 2 },
        ],
        secrets: { PW: 'pw' },
        connections: {
            dw: {
                name: 'DW',
                type: 'redshift',
                config: { host: 'dw.example.com', port: '5439', database: 'sales', user: 'w', password: 'PW' },
            },
        },
        databases: {
            redshift: async function* ({ signal: _s, connection: _c, ...query }) {
                queries.push(query);
                yield { id: 1 };
            },
        },
    });
    expect(queries.map(q => q.sql)).toEqual(['SELECT id FROM te1.briefs WHERE id = @id']);
    const node = run.components.find(c => c.nodeId === 'q')!;
    expect(node.logs.some(l => l.level === 'error' && l.message.includes('{{schema}} "te1; DROP TABLE x" is not a valid name'))).toBe(true);
});

test('a write component takes its table from an expression: a batch per table, an invalid name an error of that envelope', async () => {
    const writes: Omit<RowWrite, 'signal' | 'connection'>[] = [];
    const flow: ExecutableFlow = {
        project: 'Test',
        flow: 'W',
        parameters: [],
        nodes: [
            { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
            {
                id: 'w',
                type: 'redshift-insert',
                label: 'W',
                config: {
                    connection: 'dw',
                    table: { value: "$tenant + '.briefs'", expression: true },
                    columns: [{ column: 'id', value: '$id', expression: true }],
                    onError: 'continue',
                },
            },
            { id: 'end', type: 'end', label: 'End', config: {} },
        ],
        edges: [
            { source: 'start', sourcePort: 'out-0', target: 'w', targetPort: 'in-0' },
            { source: 'w', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        ],
    };
    expect(COMPONENTS['redshift-insert']!.validate(flow.nodes[1]!.config)).toEqual([]);
    expect(COMPONENTS['redshift-insert']!.validate({ ...flow.nodes[1]!.config, table: { value: ' ', expression: true } })).toContain(
        'has no table expression.',
    );
    const run = await flowRunner(flow, {
        mode: 'execution',
        id: 'w',
        evaluate,
        input: [
            { tenant: 'te0', id: 1 },
            { tenant: 'te0', id: 2 },
            { tenant: 'bad name', id: 3 },
            { tenant: 'te1', id: 4 },
        ],
        secrets: { PW: 'pw' },
        connections: {
            dw: {
                name: 'DW',
                type: 'redshift',
                config: { host: 'dw.example.com', port: '5439', database: 'sales', user: 'w', password: 'PW' },
            },
        },
        databaseWrites: {
            redshift: async ({ signal: _s, connection: _c, ...write }) => {
                writes.push(write);
                return { results: write.rows.map(() => 'inserted') };
            },
        },
    });
    expect(writes.map(w => [w.table, w.rows])).toEqual([
        ['te0.briefs', [[1], [2]]],
        ['te1.briefs', [[4]]],
    ]);
    const node = run.components.find(c => c.nodeId === 'w')!;
    expect(node.logs.some(l => l.level === 'error' && l.message.includes('The table expression gives the table "bad name.briefs"'))).toBe(
        true,
    );
});
