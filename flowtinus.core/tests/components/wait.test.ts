import { expect, test } from 'bun:test';
import { COMPONENTS, flowRunner, inputPorts } from '../../src/index';
import type { ExecutableFlow, WaitSummary } from '../../src/index';
import { evaluate } from '../helpers';

/**
 * Start (one job: {job, items}) → hold of the Wait; and Start → Split (its items) → Mapper (fails on a bad item, onError
 * divert) → its output AND its error port both into watch. Wait → End. The job's envelope must wait for every item.
 */
const flow = (waitConfig: Record<string, unknown> = {}, node: Partial<ExecutableFlow['nodes'][number]> = {}): ExecutableFlow => ({
    project: 'Test',
    flow: 'Wait',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
        { id: 'split', type: 'split', label: 'Items', config: { list: '$items' } },
        {
            id: 'work',
            type: 'mapper',
            label: 'Work',
            config: {
                onError: 'divert',
                fields: [{ target: 'done', value: "$bad ? (() => { throw new Error('bad item ' + $n); })() : $n * 2", expression: true }],
            },
        },
        { id: 'wait', type: 'wait', label: 'Wait', config: waitConfig, ...node },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'wait', targetPort: 'in-0' },
        { source: 'start', sourcePort: 'out-0', target: 'split', targetPort: 'in-0' },
        { source: 'split', sourcePort: 'out-0', target: 'work', targetPort: 'in-0' },
        { source: 'work', sourcePort: 'out-0', target: 'wait', targetPort: 'in-1' },
        { source: 'work', sourcePort: 'error', target: 'wait', targetPort: 'in-1' },
        { source: 'wait', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

const run = async (items: unknown[], node: Partial<ExecutableFlow['nodes'][number]> = {}) => {
    const r = await flowRunner(flow({}, node), { mode: 'execution', id: 'w', evaluate, input: [{ job: 'J1', items }] });
    const wait = r.components.find(c => c.nodeId === 'wait')!;
    return { r, wait, out: wait.outputSample['out-0'] as Record<string, unknown>[] };
};

test('Wait has a hold and a watch input, one output, no settings', () => {
    expect(inputPorts('wait').map(p => p.label)).toEqual(['hold', 'watch']);
    expect(COMPONENTS.wait.validate({})).toEqual([]);
});

test('Wait lets the held envelope go after everything watched ended: success, with how many and the last one', async () => {
    const items = Array.from({ length: 2000 }, (_, i) => ({ n: i + 1 }));
    const { r, wait, out } = await run(items);
    expect(r.status).toBe('completed');
    expect(wait.outputs['out-0']).toBe(1);
    expect(out[0]!.job).toBe('J1');
    expect(out[0]!.wait).toEqual({
        status: 'success',
        envelopes: 2000,
        errors: 0,
        firstError: null,
        last: { n: 2000, done: 4000 },
    } satisfies WaitSummary);
});

test('Wait: an envelope from the error port makes it a failure, with the first error', async () => {
    const { out } = await run([{ n: 1 }, { n: 2, bad: true }, { n: 3, bad: true }, { n: 4 }]);
    const summary = out[0]!.wait as WaitSummary;
    expect(summary.status).toBe('failure');
    expect(summary.envelopes).toBe(2);
    expect(summary.errors).toBe(2);
    expect(summary.firstError).toEqual({ error: 'Error', message: expect.stringContaining('bad item 2'), component: 'Work' });
});

test('Wait answers even when nothing was watched: empty', async () => {
    const { r, out } = await run([]);
    expect(r.status).toBe('completed');
    expect(out[0]!.wait).toEqual({ status: 'empty', envelopes: 0, errors: 0, firstError: null, last: null });
});

test('Wait: its output key and Override (DATA becomes only the summary)', async () => {
    const keyed = await run([{ n: 1 }], { outputKey: 'processing' });
    expect((keyed.out[0]!.processing as WaitSummary).status).toBe('success');
    const only = await run([{ n: 1 }], { override: true });
    expect(Object.keys(only.out[0]!).sort()).toEqual(['envelopes', 'errors', 'firstError', 'last', 'status']);
});

test('Wait counts every envelope of two branches into watch (fan-in: their writers no longer lose each other)', async () => {
    // like a probe that splits the same list twice, each branch with its output and error port into watch; the Splits
    // also send theirs (all at once), so several writers wait for space in watch at the same time
    const branch = (id: string) => [
        { id: `split${id}`, type: 'split', label: `Split ${id}`, config: { list: '$items', onError: 'divert' } },
        { id: `work${id}`, type: 'mapper', label: `Work ${id}`, config: { onError: 'divert', fields: [{ target: 'b', value: id }] } },
    ];
    const edges = (id: string) => [
        { source: 'start', sourcePort: 'out-0', target: `split${id}`, targetPort: 'in-0' },
        { source: `split${id}`, sourcePort: 'out-0', target: `work${id}`, targetPort: 'in-0' },
        { source: `split${id}`, sourcePort: 'out-0', target: 'wait', targetPort: 'in-1' },
        { source: `split${id}`, sourcePort: 'error', target: 'wait', targetPort: 'in-1' },
        { source: `work${id}`, sourcePort: 'out-0', target: 'wait', targetPort: 'in-1' },
        { source: `work${id}`, sourcePort: 'error', target: 'wait', targetPort: 'in-1' },
    ];
    const fanIn: ExecutableFlow = {
        project: 'Test',
        flow: 'Wait fan-in',
        parameters: [],
        nodes: [
            { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
            ...branch('A'),
            ...branch('B'),
            { id: 'wait', type: 'wait', label: 'Wait', config: {} },
            { id: 'end', type: 'end', label: 'End', config: {} },
        ],
        edges: [
            { source: 'start', sourcePort: 'out-0', target: 'wait', targetPort: 'in-0' },
            ...edges('A'),
            ...edges('B'),
            { source: 'wait', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        ],
    };
    const items = Array.from({ length: 2000 }, (_, i) => ({ n: i }));
    const r = await flowRunner(fanIn, { mode: 'validation', id: 'w', evaluate, input: [{ items }] });
    const wait = r.components.find(c => c.nodeId === 'wait')!;
    expect(r.status).toBe('completed');
    expect(wait.inputs['in-1']).toBe(8000);
    expect(((wait.outputSample['out-0'] as Record<string, unknown>[])[0]!.wait as WaitSummary).envelopes).toBe(8000);
}, 20000);
