import { expect, test } from 'bun:test';
import { checkFlow, checkFlowYaml, numberRangeIssues } from '#validation/flow-issues';
import type { SettingField } from '#types/setting-field.type';

const node = (id: string, type: string, config: Record<string, unknown> = {}, x = 0) => ({ id, type, position: { x, y: 0 }, config });
const edge = (source: string, target: string, sourcePort = 'out-0', targetPort = 'in-0') => ({ source, sourcePort, target, targetPort });

const flow = (nodes: unknown[], edges: unknown[]) => ({ version: 1, name: 'F', nodes, edges });

test('a valid flow: ok, no issues, the flow as read', () => {
    const check = checkFlow(
        flow(
            [node('start', 'start'), node('f', 'filter', { condition: '$a > 1' }, 160), node('end', 'end', {}, 320)],
            [edge('start', 'f'), edge('f', 'end')],
        ),
    );
    expect(check.issues).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.flow?.nodes).toHaveLength(3);
    // the false output is optional: no warning
    expect(check.warnings).toEqual([]);
});

test('YAML that does not parse is one issue', () => {
    const check = checkFlowYaml('nodes: [');
    expect(check.ok).toBe(false);
    expect(check.issues[0]!.message).toStartWith('Not valid YAML');
});

test('shape errors point at the node when they name one', () => {
    const check = checkFlow(flow([node('start', 'start'), { id: 'x', type: 'filter' }, node('end', 'end')], []));
    expect(check.ok).toBe(false);
    expect(check.issues).toContainEqual({ nodeId: 'x', message: 'Node "x" has no position.' });
});

test("unknown types, a component's own issues, broken expressions and output keys, each with its node and setting", () => {
    const check = checkFlow(
        flow(
            [
                node('start', 'start'),
                node('u', 'nope'),
                node('f', 'filter', { condition: '' }),
                node('m', 'mapper', { fields: [{ target: 'ok', value: '$a +', expression: true }] }),
                { ...node('l', 'log', { message: '$a' }), outputKey: '1bad' },
                node('end', 'end'),
            ],
            [edge('start', 'u'), edge('start', 'f'), edge('f', 'm'), edge('m', 'l'), edge('l', 'end')],
        ),
    );
    expect(check.ok).toBe(false);
    expect(check.issues.find(i => i.nodeId === 'u')!.message).toContain('unknown type "nope"');
    expect(check.issues.find(i => i.nodeId === 'f')!.message).toBe('"Filter" has no condition.');
    expect(check.issues.find(i => i.nodeId === 'm')).toMatchObject({ settingKey: 'fields.0.value' });
    expect(check.issues.find(i => i.nodeId === 'l')).toMatchObject({ settingKey: 'outputKey' });
});

test('a disabled component is not checked', () => {
    const check = checkFlow(
        flow(
            [node('start', 'start'), { ...node('f', 'filter', { condition: '' }), disabled: true }, node('end', 'end')],
            [edge('start', 'f'), edge('f', 'end')],
        ),
    );
    expect(check.ok).toBe(true);
});

test('a number setting outside its min/max is an issue of its node, only while the setting applies (its when)', () => {
    const check = (config: Record<string, unknown>) =>
        checkFlow(
            flow(
                [node('start', 'start'), node('a', 'aggregate', config, 300), node('end', 'end', {}, 600)],
                [edge('start', 'a'), edge('a', 'end')],
            ),
        );
    const zero = check({ mode: 'size', size: 0, field: 'items' });
    expect(zero.ok).toBe(false);
    expect(zero.issues).toEqual([
        { nodeId: 'a', settingKey: 'size', message: '"Aggregate": Envelopes per batch (size) is 0, below its minimum 1.' },
    ]);
    // the default mode is size: it applies too; a quoted number counts as one; above the max as well
    expect(check({ size: '0' }).issues[0]).toMatchObject({ settingKey: 'size' });
    expect(check({ size: 20_000 }).issues[0]!.message).toContain('is 20000, above its maximum 10000');
    // Batch size All: size does not apply
    expect(check({ mode: 'all', size: 0, field: 'items' }).ok).toBe(true);
    // in range, unset (its default) or not a number (the component's to read): nothing
    expect(check({ size: 1 }).ok).toBe(true);
    expect(check({}).ok).toBe(true);
    expect(check({ size: 'many' }).ok).toBe(true);
});

test("a number setting in a list's items is checked against its bounds, with the item's key", () => {
    const fields: SettingField[] = [
        {
            key: 'rows',
            label: 'Rows',
            kind: 'list',
            item: [
                { key: 'name', label: 'Name', kind: 'text' },
                { key: 'n', label: 'N', kind: 'number', min: 1, max: 5 },
            ],
        },
    ];
    expect(numberRangeIssues(fields, { rows: [{ name: 'a', n: 3 }, { name: 'b', n: 9 }, { name: 'c' }] })).toEqual([
        { key: 'rows.1.n', label: 'N', value: 9, message: 'is 9, above its maximum 5' },
    ]);
});

test('a cycle is an issue', () => {
    const check = checkFlow(
        flow(
            [node('start', 'start'), node('a', 'log', { message: '1' }), node('b', 'log', { message: '2' }), node('end', 'end')],
            [edge('start', 'a'), edge('a', 'b'), edge('b', 'a'), edge('b', 'end')],
        ),
    );
    expect(check.issues.some(i => i.message.includes('cycle'))).toBe(true);
});

test('warnings: an input nothing feeds and a required output left unconnected', () => {
    const check = checkFlow(
        flow(
            [node('start', 'start'), node('a', 'log', { message: '1' }), node('b', 'log', { message: '2' }), node('end', 'end')],
            [edge('start', 'a'), edge('b', 'end')],
        ),
    );
    expect(check.ok).toBe(true);
    expect(check.warnings).toContainEqual(expect.objectContaining({ nodeId: 'a', port: 'out-0' }));
    expect(check.warnings).toContainEqual(expect.objectContaining({ nodeId: 'b', port: 'in-0' }));
});

test('warnings: a card drawn over another; cards fitted side by side (160 px apart) or stacked are fine', () => {
    const at = (id: string, type: string, x: number, y: number, config: Record<string, unknown> = {}) => ({
        id,
        type,
        position: { x, y },
        config,
    });
    const nodes = (b: [number, number], c: [number, number]) => [
        at('start', 'start', 0, 0),
        at('b', 'log', ...b, { message: '1' }),
        at('c', 'log', ...c, { message: '2' }),
        at('end', 'end', 640, 0),
    ];
    const edges = [edge('start', 'b'), edge('b', 'c'), edge('c', 'end')];
    const over = (b: [number, number], c: [number, number]) =>
        checkFlow(flow(nodes(b, c), edges)).warnings.filter(w => w.message.includes('is drawn over'));
    // fitted in a row, and one under another a grid step apart: no warning
    expect(over([160, 0], [320, 0])).toEqual([]);
    expect(over([160, 0], [160, 80])).toEqual([]);
    // half a card over the other, and on the same spot
    expect(over([160, 0], [240, 32]).map(w => w.nodeId)).toEqual(['c']);
    expect(over([160, 0], [160, 0])[0]!.message).toStartWith('"Log" (c) is drawn over "Log" (b) at positions 160,0 and 160,0:');
});

test('warnings, not issues: an expression that is a function called in place (an IIFE) or very long suggests a TypeScript component', () => {
    const check = (value: string) =>
        checkFlow(
            flow(
                [
                    node('start', 'start'),
                    node('m', 'mapper', { fields: [{ target: 'row', value, expression: true }] }, 160),
                    node('end', 'end', {}, 320),
                ],
                [edge('start', 'm'), edge('m', 'end')],
            ),
        );
    const iife = check("(() => { const d = $DATA; if (!d.id) throw new Error('no id'); return { id: d.id }; })()");
    expect(iife.ok).toBe(true);
    expect(iife.warnings).toEqual([
        expect.objectContaining({
            nodeId: 'm',
            settingKey: 'fields.0.value',
            message: expect.stringContaining('is a function called in place (an IIFE)'),
        }),
    ]);
    expect(check(`'${'x'.repeat(320)}'`).warnings[0]!.message).toContain('has 322 characters');
    // short expressions, arrows inside calls: no warning
    for (const fine of [
        '$price * $quantity',
        '$items.map(x => x.id).filter(Boolean)',
        '$items.reduce((s, x) => s + x.total, 0) + (1)',
        '$a ? ($b) : ($c)',
    ]) {
        expect(check(fine).warnings).toEqual([]);
    }
});
