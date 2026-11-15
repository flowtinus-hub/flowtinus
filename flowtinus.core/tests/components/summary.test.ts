import { expect, test } from 'bun:test';
import { COMPONENTS, componentSummary } from '../../src/index';

test('the summary of a component reads its config: Mapper fields, Router cases, Filter condition, Log message', () => {
    expect(
        componentSummary('mapper', {
            fields: [
                { target: 'total', value: '$price * $qty', expression: true },
                { target: 'origin', value: 'web', expression: false },
            ],
        }),
    ).toEqual([
        {
            title: 'Fields',
            lines: [
                { label: '$total', value: '$price * $qty', code: true },
                { label: '$origin', value: '"web"', code: true },
            ],
        },
    ]);
    expect(
        componentSummary('router', {
            cases: [
                { label: 'SP', condition: '$state === "SP"' },
                { label: '', condition: '$total > 100' },
            ],
        }),
    ).toEqual([
        {
            title: 'Cases',
            lines: [
                { label: 'SP', value: '$state === "SP"', code: true },
                { label: 'case 2', value: '$total > 100', code: true },
            ],
        },
    ]);
    expect(componentSummary('filter', { condition: '$price > 10' })).toEqual([
        { title: 'Condition', lines: [{ value: '$price > 10', code: true }] },
    ]);
    expect(componentSummary('log', { level: 'warn', message: '`order ${$id}`' })).toEqual([
        { title: 'Message', lines: [{ label: 'warn', value: '`order ${$id}`', code: true }] },
    ]);
});

test('nothing set yet: no sections (the editor says so); settings with defaults always show', () => {
    for (const type of ['mapper', 'router', 'filter', 'log', 'sort', 'distinct', 'lookup', 'sqlserver', 'http-request', 'flow']) {
        expect(`${type}: ${JSON.stringify(componentSummary(type, {}))}`).toBe(`${type}: []`);
    }
    expect(componentSummary('limit', {})).toEqual([{ title: 'Limit', lines: [{ value: 'First 10' }] }]);
    expect(componentSummary('unknown', { fields: [1] })).toEqual([]);
});

test('every component has a summary case (none falls to the default by mistake)', () => {
    const withConfig: Record<string, Record<string, unknown>> = {
        mapper: { fields: [{ target: 'a', value: '1', expression: true }] },
        filter: { condition: 'true' },
        router: { cases: [{ label: 'a', condition: 'true' }] },
        log: { message: 'x' },
        sort: { keys: [{ value: '$a', direction: 'asc' }] },
        distinct: { keys: ['$a'] },
        lookup: { keys: [{ main: '$a', lookup: '$b' }] },
        datagrid: { columns: [{ name: 'a', type: 'text' }], rows: [['1']] },
        sqlserver: { connection: 'db', sql: 'SELECT 1' },
        redshift: { connection: 'dw', sql: 'SELECT 1' },
        'redshift-insert': { connection: 'dw', table: 't' },
        'redshift-upsert': { connection: 'dw', table: 't' },
        'redshift-delete': { connection: 'dw', table: 't' },
        'sqlserver-insert': { connection: 'db', table: 't' },
        'sqlserver-update': { connection: 'db', table: 't' },
        'sqlserver-delete': { connection: 'db', table: 't' },
        'sqlserver-execute': { connection: 'db', sql: 'SELECT 1' },
        'redshift-execute': { connection: 'dw', sql: 'SELECT 1' },
        'mongodb-pipeline': { collection: 'orders' },
        'mongodb-upsert': { collection: 'orders' },
        'mongodb-delete': { collection: 'orders' },
        'http-request': { url: { value: 'https://example.com', expression: false } },
        flow: { flowId: 'f1' },
        script: { function: 'math/ops#times' },
    };
    for (const type of Object.keys(COMPONENTS)) {
        expect(`${type}: ${componentSummary(type, withConfig[type] ?? {}).length > 0}`).toBe(`${type}: true`);
    }
});

test('a connection shows the profile by its name (the editor gives the names), or what its own fields say', () => {
    const names = (id: string) => ({ erp: 'ERP' })[id];
    expect(componentSummary('sqlserver', { connection: 'erp', sql: 'SELECT 1' }, names)[0]).toEqual({
        title: 'Connection',
        lines: [{ value: 'ERP' }],
    });
    expect(componentSummary('sqlserver', { host: 'db.local', database: 'crm' })[0]).toEqual({
        title: 'Connection',
        lines: [{ value: 'db.local / crm', code: false }],
    });
    expect(componentSummary('http-request', { url: { value: 'https://x.test', expression: false }, auth: 'bearer' })[1]).toEqual({
        title: 'Connection',
        lines: [{ value: 'Bearer token', code: false }],
    });
});

test('a MongoDB collection: database.collection when fixed (plain text from older flows too), each line when one is an expression', () => {
    const target = (config: Record<string, unknown>) =>
        componentSummary('mongodb-delete', { connectionString: 'M', filter: '', ...config }).find(s => s.title === 'Collection');
    expect(target({ database: 'crm', collection: { value: 'orders', expression: false } })).toEqual({
        title: 'Collection',
        lines: [{ value: 'crm.orders', code: false }],
    });
    expect(target({ database: 'crm', collection: { value: "'orders_' + $year", expression: true } })).toEqual({
        title: 'Collection',
        lines: [
            { label: 'Database', value: '"crm"', code: true },
            { label: 'Collection', value: "'orders_' + $year", code: true },
        ],
    });
});
