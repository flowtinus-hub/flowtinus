import { expect, test } from 'bun:test';
import { COMPONENTS, componentSummary, flowRunner } from '../../src/index';
import type { ExecutableFlow } from '../../src/index';
import { evaluate } from '../helpers';

/** Start (its input, one envelope per item) → Aggregate → End */
const flow = (config: Record<string, unknown>): ExecutableFlow => ({
    project: 'Test',
    flow: 'Aggregate',
    parameters: [{ name: 'region', type: 'text', default: 'north' }],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
        { id: 'ag', type: 'aggregate', label: 'Aggregate', config },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'ag', targetPort: 'in-0' },
        { source: 'ag', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));
const run = (config: Record<string, unknown>, input: unknown[]) =>
    flowRunner(flow(config), { mode: 'execution', id: crypto.randomUUID(), evaluate, input });
const ag = (r: Awaited<ReturnType<typeof flowRunner>>) => r.components.find(c => c.nodeId === 'ag')!;

test('Aggregate: batches of N; the size only shows (and counts) for Every N envelopes', async () => {
    const r = await run({ size: 3 }, items(7));
    expect(ag(r).outputSample['out-0'].map(d => (d.items as unknown[]).length)).toEqual([3, 3, 1]);
    const visible = COMPONENTS.aggregate.settings?.find(s => s.key === 'size')?.when;
    expect(visible).toEqual({ key: 'mode', values: ['size'] });
});

test('Aggregate, Batch size All: one batch with every envelope when the input ends, past the largest N', async () => {
    const r = await run({ mode: 'all', size: 3 }, items(12_000));
    const out = ag(r).outputSample['out-0'];
    expect(out).toHaveLength(1);
    expect((out[0]!.items as { id: number }[]).map(d => d.id)).toEqual(items(12_000).map(d => d.id));
    expect(ag(r).logs.at(-1)?.message).toBe('12000 envelope(s) in 1 batch(es) (all).');
    expect(componentSummary('aggregate', { mode: 'all', field: 'rows', whenEmpty: true })).toEqual([
        { title: 'Batches', lines: [{ value: 'all in one batch, in $rows; [] when empty' }] },
    ]);
});

test('Aggregate: an input that ends empty yields nothing, or {items: []} with the run and its parameters', async () => {
    const none = await run({ mode: 'all' }, []);
    expect(ag(none).outputs['out-0'] ?? 0).toBe(0);
    for (const mode of ['all', 'size']) {
        const r = await run({ mode, field: 'rows', whenEmpty: true }, []);
        expect(ag(r).outputSample['out-0']).toEqual([{ rows: [] }]);
        expect(r.status).toBe('completed');
    }
    // the envelope it makes carries the run's parameters, as one that came in would
    const withParameter: ExecutableFlow = flow({ mode: 'all', whenEmpty: true });
    withParameter.nodes.splice(2, 0, {
        id: 'map',
        type: 'mapper',
        label: 'Map',
        config: { fields: [{ target: 'region', value: '$PARAMETERS.region', expression: true }] },
    });
    withParameter.edges = [
        { source: 'start', sourcePort: 'out-0', target: 'ag', targetPort: 'in-0' },
        { source: 'ag', sourcePort: 'out-0', target: 'map', targetPort: 'in-0' },
        { source: 'map', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ];
    const r = await flowRunner(withParameter, { mode: 'execution', id: 'agp', evaluate, input: [] });
    expect(r.components.find(c => c.nodeId === 'map')!.outputSample['out-0']).toEqual([{ items: [], region: 'north' }]);
});
