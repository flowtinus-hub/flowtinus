import { expect, test } from 'bun:test';
import { applyRunFrom, flowRunner, planRunFrom } from '../../src/index';
import type { ExecutableFlow, ExecutableNode, RunOptions } from '../../src/index';
import { evaluate } from '../helpers';

/**
 * Start → Loop → End; inside the Loop: Iteration start → Mapper (i = $_loopIndex) → Iteration end. Each test changes the
 * Loop's config or the region.
 */
const loopFlow = (
    config: Record<string, unknown>,
    region: { nodes?: ExecutableNode[]; edges?: ExecutableFlow['edges'] } = {},
    loop: Partial<ExecutableNode> = {},
): ExecutableFlow => ({
    project: 'Test',
    flow: 'Loop',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
        { id: 'loop', type: 'loop', label: 'Loop', config, ...loop },
        ...(region.nodes ?? [
            {
                id: 'index',
                type: 'mapper',
                label: 'Index',
                loop: 'loop',
                config: { fields: [{ target: 'i', value: '$_loopIndex', expression: true }] },
            },
        ]),
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'loop', targetPort: 'in-0' },
        { source: 'loop', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        ...(region.edges ?? [
            { source: 'loop', sourcePort: 'iteration-start', target: 'index', targetPort: 'in-0' },
            { source: 'index', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
        ]),
    ],
});

const run = async (wf: ExecutableFlow, input: unknown = [{ name: 'A' }], options: Partial<RunOptions> = {}) => {
    const reached: Record<string, unknown>[] = [];
    const record = await flowRunner(wf, {
        mode: 'execution',
        id: 'r',
        evaluate,
        input,
        onReachEnd: async doc => void reached.push(doc.DATA),
        ...options,
    });
    return { record, reached, loop: record.components.find(c => c.nodeId === 'loop')! };
};

test('a Loop runs its region once per iteration until the stop condition is true; what reaches Iteration end goes out', async () => {
    const { record, reached } = await run(loopFlow({ maxIterations: 100, stopCondition: '$_loopIndex >= 3' }));
    expect(record.status).toBe('completed');
    expect(reached).toEqual([
        { name: 'A', i: 0 },
        { name: 'A', i: 1 },
        { name: 'A', i: 2 },
    ]);
});

test('checked before, a stop condition already true runs no iteration; checked after (do-while), the first always runs', async () => {
    const before = await run(loopFlow({ maxIterations: 100, stopCondition: 'true' }));
    expect(before.loop.status).toBe('completed');
    expect(before.reached).toEqual([]);

    const after = await run(loopFlow({ maxIterations: 100, stopCondition: 'true', checkTiming: 'after' }));
    expect(after.reached).toEqual([{ name: 'A', i: 0 }]);

    const twice = await run(loopFlow({ maxIterations: 100, stopCondition: '$_loopIndex >= 2', checkTiming: 'after' }));
    expect(twice.reached.map(d => d.i)).toEqual([0, 1]);
});

test('the stop condition reads the loop state', async () => {
    const { reached } = await run(loopFlow({ maxIterations: 100, stopCondition: '$_loopIndex >= $pages' }), [{ pages: 2 }]);
    expect(reached).toEqual([
        { pages: 2, i: 0 },
        { pages: 2, i: 1 },
    ]);
});

test('without Continue every iteration starts with the same loop state', async () => {
    const change = {
        id: 'change',
        type: 'mapper',
        label: 'Change',
        loop: 'loop',
        config: {
            fields: [
                { target: 'seen', value: '$name', expression: true },
                { target: 'name', value: 'changed', expression: false },
            ],
        },
    };
    const { reached } = await run(
        loopFlow(
            { maxIterations: 100, stopCondition: '$_loopIndex >= 2' },
            {
                nodes: [change],
                edges: [
                    { source: 'loop', sourcePort: 'iteration-start', target: 'change', targetPort: 'in-0' },
                    { source: 'change', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
                ],
            },
        ),
    );
    expect(reached).toEqual([
        { name: 'changed', seen: 'A' },
        { name: 'changed', seen: 'A' },
    ]);
});

test('reaching max iterations ends the loop without an error: the Loop ends with warnings', async () => {
    const { record, reached, loop } = await run(loopFlow({ maxIterations: 3 }));
    expect(reached.map(d => d.i)).toEqual([0, 1, 2]);
    expect(loop.status).toBe('with-warnings');
    expect(record.status).toBe('with-warnings');
    expect(loop.logs.some(l => l.level === 'warning' && l.message.startsWith('Max iterations (3) reached'))).toBe(true);
});

test('a stop condition that ends the loop at max iterations is no warning', async () => {
    const { loop } = await run(loopFlow({ maxIterations: 3, stopCondition: '$_loopIndex >= 3' }));
    expect(loop.status).toBe('completed');
});

test('a test run stops every loop at 50 iterations', async () => {
    const { reached, loop } = await run(loopFlow({ maxIterations: 100 }), [{ name: 'A' }], { mode: 'validation' });
    expect(reached).toHaveLength(50);
    expect(loop.status).toBe('with-warnings');
    expect(loop.logs.some(l => l.message.startsWith('Max iterations (50) reached'))).toBe(true);

    const real = await run(loopFlow({ maxIterations: 100 }));
    expect(real.reached).toHaveLength(100);
});

test('each envelope that comes in runs a loop of its own, one after another in arrival order, its index from 0', async () => {
    const { reached } = await run(loopFlow({ maxIterations: 100, stopCondition: '$_loopIndex >= 2' }), [
        { name: 'A' },
        { name: 'B' },
        { name: 'C' },
    ]);
    expect(reached).toEqual([
        { name: 'A', i: 0 },
        { name: 'A', i: 1 },
        { name: 'B', i: 0 },
        { name: 'B', i: 1 },
        { name: 'C', i: 0 },
        { name: 'C', i: 1 },
    ]);
});

test('an Aggregate inside the region aggregates per iteration', async () => {
    const { reached } = await run(
        loopFlow(
            { maxIterations: 2 },
            {
                nodes: [
                    { id: 'split', type: 'split', label: 'Split', loop: 'loop', config: { list: '$items' } },
                    { id: 'all', type: 'aggregate', label: 'All', loop: 'loop', config: { mode: 'all', field: 'items' } },
                ],
                edges: [
                    { source: 'loop', sourcePort: 'iteration-start', target: 'split', targetPort: 'in-0' },
                    { source: 'split', sourcePort: 'out-0', target: 'all', targetPort: 'in-0' },
                    { source: 'all', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
                ],
            },
        ),
        [{ items: [{ n: 1 }, { n: 2 }, { n: 3 }] }],
    );
    expect(reached).toEqual([{ items: [{ n: 1 }, { n: 2 }, { n: 3 }] }, { items: [{ n: 1 }, { n: 2 }, { n: 3 }] }]);
});

test('Iteration start straight to Iteration end: the loop state goes out in every iteration', async () => {
    const { record, reached } = await run(
        loopFlow(
            { maxIterations: 2 },
            { nodes: [], edges: [{ source: 'loop', sourcePort: 'iteration-start', target: 'loop', targetPort: 'iteration-end' }] },
        ),
    );
    expect(record.status).toBe('with-warnings');
    expect(reached).toEqual([{ name: 'A' }, { name: 'A' }]);
});

test("$_loopIndex is the Loop's: it wins over a DATA key of the same name, and is not there outside a Loop", async () => {
    const { reached } = await run(loopFlow({ maxIterations: 100, stopCondition: '$_loopIndex >= 1' }), [{ _loopIndex: 'mine' }]);
    expect(reached).toEqual([{ _loopIndex: 'mine', i: 0 }]);
});

test('a run refuses an open loop region; Iteration start → … → Iteration end is no cycle', async () => {
    const wf = loopFlow({ maxIterations: 1 });
    wf.edges.push({ source: 'index', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' });
    const { record } = await run(wf);
    expect(record.status).toBe('failed');
    expect(record.error).toContain('a loop region is closed');

    const loopBack = loopFlow({ maxIterations: 1 });
    expect((await run(loopBack)).record.error).toBeUndefined();
});

/** Iteration start → Page (page = $_loopIndex + 1, carried in the state) → Iteration end and → Continue */
const pager = (more: Partial<ExecutableFlow> = {}) =>
    loopFlow(
        { maxIterations: 100, stopCondition: '$_loopIndex >= 3' },
        {
            nodes: [
                {
                    id: 'page',
                    type: 'mapper',
                    label: 'Page',
                    loop: 'loop',
                    config: { fields: [{ target: 'page', value: '($page ?? 0) + 1', expression: true }] },
                },
                { id: 'next', type: 'continue', label: 'Next', loop: 'loop', config: {} },
                ...(more.nodes ?? []),
            ],
            edges: [
                { source: 'loop', sourcePort: 'iteration-start', target: 'page', targetPort: 'in-0' },
                { source: 'page', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
                { source: 'page', sourcePort: 'out-0', target: 'next', targetPort: 'in-0' },
                ...(more.edges ?? []),
            ],
        },
    );

test('the envelope that reaches Continue is the loop state of the next iteration', async () => {
    const { record, reached } = await run(pager());
    expect(record.status).toBe('completed');
    expect(reached).toEqual([
        { name: 'A', page: 1 },
        { name: 'A', page: 2 },
        { name: 'A', page: 3 },
    ]);
});

/** a Filter on the page (Last: $page >= 2) → Break, beside the pager's Continue */
const lastPage = (condition = '$page >= 2') => ({
    nodes: [
        { id: 'last', type: 'filter', label: 'Last', loop: 'loop', config: { condition } },
        { id: 'stop', type: 'break', label: 'Stop', loop: 'loop', config: {} },
    ],
    edges: [
        { source: 'page', sourcePort: 'out-0', target: 'last', targetPort: 'in-0' },
        { source: 'last', sourcePort: 'out-0', target: 'stop', targetPort: 'in-0' },
    ],
});

test("Break ends the loop after the iteration, wins over that iteration's Continue; what reached Iteration end still goes out", async () => {
    const { record, reached, loop } = await run(pager(lastPage()), [{ name: 'A' }, { name: 'B', page: 5 }]);
    expect(record.status).toBe('completed');
    expect(loop.status).toBe('completed');
    // the envelope that reached Break does not go out of the Loop: only what reached Iteration end
    expect(reached).toEqual([
        { name: 'A', page: 1 },
        { name: 'A', page: 2 },
        { name: 'B', page: 6 },
    ]);
});

test('more than one envelope at Continue in an iteration is an error of the Loop for that input envelope; Break still wins', async () => {
    const twice = {
        nodes: [{ id: 'again', type: 'continue', label: 'Again', loop: 'loop', config: {} }],
        edges: [{ source: 'page', sourcePort: 'out-0', target: 'again', targetPort: 'in-0' }],
    };
    const failed = await run(pager(twice));
    expect(failed.record.status).toBe('failed');
    expect(failed.record.error).toContain('Iteration 0: 2 envelopes reached Continue');

    const divert = pager(twice);
    divert.nodes.find(n => n.id === 'loop')!.config.onError = 'continue';
    const goesOn = await run(divert, [{ name: 'A' }, { name: 'B' }]);
    expect(goesOn.loop.status).toBe('with-errors');
    expect(goesOn.reached).toEqual([{ name: 'A', page: 1 }, { name: 'A' }, { name: 'B', page: 1 }, { name: 'B' }]);

    const broken = await run(
        pager({ nodes: [...twice.nodes, ...lastPage('true').nodes], edges: [...twice.edges, ...lastPage('true').edges] }),
    );
    expect(broken.record.status).toBe('completed');
    expect(broken.reached).toEqual([{ name: 'A', page: 1 }]);
});

test('a run refuses a Continue or Break outside every Loop', async () => {
    const wf = loopFlow({ maxIterations: 1 });
    wf.nodes.push({ id: 'stray', type: 'break', label: 'Stray', config: {} });
    wf.edges.push({ source: 'start', sourcePort: 'out-0', target: 'stray', targetPort: 'in-0' });
    const { record } = await run(wf);
    expect(record.status).toBe('failed');
    expect(record.error).toContain('"Stray" is outside every Loop');
});

test('a Flow Invoker inside a loop region runs the whole called flow (it is not inside the Loop)', async () => {
    const child: ExecutableFlow = {
        project: 'Test',
        flow: 'child',
        parameters: [],
        nodes: [
            { id: 's', type: 'start', label: 'Start', config: { acceptsInput: true } },
            { id: 'm', type: 'mapper', label: 'Mark', config: { fields: [{ target: 'called', value: 'yes', expression: false }] } },
            { id: 'e', type: 'end', label: 'End', config: {} },
        ],
        edges: [
            { source: 's', sourcePort: 'out-0', target: 'm', targetPort: 'in-0' },
            { source: 'm', sourcePort: 'out-0', target: 'e', targetPort: 'in-0' },
        ],
    };
    const call = { id: 'call', type: 'flow', label: 'Call', loop: 'loop', config: { flowId: 'child', sendEnvelope: true } };
    const { reached } = await run(
        loopFlow(
            { maxIterations: 1 },
            {
                nodes: [call],
                edges: [
                    { source: 'loop', sourcePort: 'iteration-start', target: 'call', targetPort: 'in-0' },
                    { source: 'call', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
                ],
            },
        ),
        [{ name: 'A' }],
        { flows: { child } },
    );
    expect(reached).toEqual([{ name: 'A', called: 'yes' }]);
});

/** a region whose Mapper (Fail, its On error `onError`) throws in iteration 1; `more` adds to the region */
const failing = (onError = 'throw', more: { nodes: ExecutableNode[]; edges: ExecutableFlow['edges'] } = { nodes: [], edges: [] }) => ({
    nodes: [
        {
            id: 'fail',
            type: 'mapper',
            label: 'Fail',
            loop: 'loop',
            config: {
                onError,
                fields: [
                    { target: 'i', value: '$_loopIndex', expression: true },
                    {
                        target: 'ok',
                        value: "$_loopIndex === 1 ? (() => { throw new Error('iteration 1 failed'); })() : true",
                        expression: true,
                    },
                ],
            },
        },
        ...more.nodes,
    ],
    edges: [
        { source: 'loop', sourcePort: 'iteration-start', target: 'fail', targetPort: 'in-0' },
        { source: 'fail', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
        ...more.edges,
    ],
});

const threeIterations = { maxIterations: 100, stopCondition: '$_loopIndex >= 3' };

/** Fail's error port → Handled → Iteration end */
const handled = {
    nodes: [
        {
            id: 'handled',
            type: 'mapper',
            label: 'Handled',
            loop: 'loop',
            config: { fields: [{ target: 'handled', value: 'yes', expression: false }] },
        },
    ],
    edges: [
        { source: 'fail', sourcePort: 'error', target: 'handled', targetPort: 'in-0' },
        { source: 'handled', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
    ],
};

test("inside a region a component's own On error works: continue goes on, divert goes out through its error port", async () => {
    const goesOn = await run(loopFlow(threeIterations, failing('continue')));
    expect(goesOn.record.status).toBe('completed');
    expect(goesOn.loop.status).toBe('completed');
    // continue sends the envelope as it came in (the loop state) to its output
    expect(goesOn.reached).toEqual([{ name: 'A', i: 0, ok: true }, { name: 'A' }, { name: 'A', i: 2, ok: true }]);

    const diverted = await run(loopFlow(threeIterations, failing('divert', handled)));
    expect(diverted.loop.status).toBe('completed');
    expect(diverted.reached).toEqual([
        { name: 'A', i: 0, ok: true },
        {
            name: 'A',
            handled: 'yes',
            errors: [expect.objectContaining({ message: expect.stringContaining('iteration 1 failed'), component: 'Fail' })],
        },
        { name: 'A', i: 2, ok: true },
    ]);
});

test("an error thrown inside the region with the Loop's On error on throw fails the run", async () => {
    const { record, reached, loop } = await run(loopFlow(threeIterations, failing()));
    expect(record.status).toBe('failed');
    expect(loop.status).toBe('failed');
    expect(record.error).toContain('iteration 1 failed');
    // what went out through Iteration end before the error stays out
    expect(reached).toEqual([{ name: 'A', i: 0, ok: true }]);
});

test("with the Loop's On error on continue, the input envelope goes out and the next one runs its loop; the Loop ends with errors", async () => {
    const { record, reached, loop } = await run(loopFlow({ ...threeIterations, onError: 'continue' }, failing()), [
        { name: 'A' },
        { name: 'B' },
    ]);
    expect(record.status).toBe('with-errors');
    expect(loop.status).toBe('with-errors');
    expect(loop.logs.some(l => l.level === 'error' && l.message.includes('iteration 1 failed'))).toBe(true);
    expect(reached).toEqual([{ name: 'A', i: 0, ok: true }, { name: 'A' }, { name: 'B', i: 0, ok: true }, { name: 'B' }]);
});

test("with the Loop's On error on divert, the input envelope goes out through the error port with the error", async () => {
    const wf = loopFlow({ ...threeIterations, onError: 'divert' }, failing());
    wf.nodes.push({
        id: 'caught',
        type: 'mapper',
        label: 'Caught',
        config: { fields: [{ target: 'caught', value: 'yes', expression: false }] },
    });
    wf.edges.push(
        { source: 'loop', sourcePort: 'error', target: 'caught', targetPort: 'in-0' },
        { source: 'caught', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    );
    const { record, reached, loop } = await run(wf, [{ name: 'A' }, { name: 'B' }]);
    expect(record.status).toBe('completed');
    expect(loop.status).toBe('completed');
    const caught = (name: string) => ({
        name,
        caught: 'yes',
        errors: [expect.objectContaining({ message: expect.stringContaining('iteration 1 failed'), component: 'Loop' })],
    });
    expect(reached).toEqual([{ name: 'A', i: 0, ok: true }, caught('A'), { name: 'B', i: 0, ok: true }, caught('B')]);
});

test('a bypassed Loop sends its input envelopes straight out and runs no iteration', async () => {
    const { record, reached, loop } = await run(loopFlow(threeIterations, {}, { disabled: true }), [{ name: 'A' }, { name: 'B' }]);
    expect(record.status).toBe('completed');
    expect(loop.status).toBe('disabled');
    // the region's Mapper (it adds i) did not run
    expect(reached).toEqual([{ name: 'A' }, { name: 'B' }]);
});

test("each iteration is a sub-run of the Loop's component run, by input envelope and loop index, with its components", async () => {
    const { loop } = await run(loopFlow({ maxIterations: 100, stopCondition: '$_loopIndex >= 2' }), [{ name: 'A' }, { name: 'B' }]);
    const subs = loop.subRuns ?? [];
    expect(subs.map(s => [s.iteration, s.status])).toEqual([
        [{ envelope: 1, index: 0 }, 'completed'],
        [{ envelope: 1, index: 1 }, 'completed'],
        [{ envelope: 2, index: 0 }, 'completed'],
        [{ envelope: 2, index: 1 }, 'completed'],
    ]);
    const mapper = subs[3]!.record!.components.find(c => c.nodeId === 'index')!;
    expect(mapper.inputs).toEqual({ 'in-0': 1 });
    expect(mapper.outputSample['out-0']).toEqual([{ name: 'B', i: 1 }]);
});

test('only the first 50 iterations are kept, across the input envelopes', async () => {
    const { reached, loop } = await run(loopFlow({ maxIterations: 30 }), [{ name: 'A' }, { name: 'B' }]);
    expect(reached).toHaveLength(60);
    const subs = loop.subRuns ?? [];
    expect(subs).toHaveLength(50);
    expect(subs.at(-1)!.iteration).toEqual({ envelope: 2, index: 19 });
});

test('a pinned component inside a region returns its pin in every iteration of a test run', async () => {
    const pinned = loopFlow({ maxIterations: 3 }, {}, {});
    pinned.nodes = pinned.nodes.map(n => (n.id === 'index' ? { ...n, pinned: { 'out-0': [{ page: 'pinned' }] } } : n));
    const { reached, loop } = await run(pinned, [{ name: 'A' }], { mode: 'validation' });
    expect(reached).toEqual([{ page: 'pinned' }, { page: 'pinned' }, { page: 'pinned' }]);
    expect(loop.subRuns!.map(s => s.record!.components.find(c => c.nodeId === 'index')!.status)).toEqual(['pinned', 'pinned', 'pinned']);
});

test('Run from here on a Loop starts it from its first iteration with the input it got in the last run', async () => {
    const wf = loopFlow({ maxIterations: 100, stopCondition: '$_loopIndex >= 2' });
    const first = await run(wf, [{ name: 'A' }, { name: 'B' }], { mode: 'validation' });
    const planned = planRunFrom(wf, 'loop', first.record.components);
    if (!planned.ok) {
        throw new Error(planned.error);
    }
    const again = await run(applyRunFrom(wf, planned.plan), undefined, { mode: 'validation', runFrom: planned.plan, input: undefined });
    expect(again.record.status).toBe('completed');
    expect(again.reached).toEqual(first.reached);
    expect(again.loop.subRuns!.map(s => s.iteration)).toEqual(first.loop.subRuns!.map(s => s.iteration));
});

test('Run from here is refused on a component inside a loop region', async () => {
    const wf = loopFlow({ maxIterations: 2 });
    const first = await run(wf, [{ name: 'A' }], { mode: 'validation' });
    expect(planRunFrom(wf, 'index', first.record.components)).toEqual({
        ok: false,
        error: 'Run from here is not offered inside a Loop: "Index" runs only in its iterations. Run from the Loop instead.',
    });
});

/**
 * Iteration start → Page (page = ($page ?? 0) + 1, i = $_loopIndex) → Fetch (GET …/$name/$page) → Iteration end, and
 * Page → Continue: two iterations per loop. The fake server sees how many requests are in flight at once.
 */
const fetching = (parallel?: boolean) =>
    loopFlow(
        { maxIterations: 100, stopCondition: '$_loopIndex >= 2', ...(parallel === undefined ? {} : { parallel }) },
        {
            nodes: [
                {
                    id: 'page',
                    type: 'mapper',
                    label: 'Page',
                    loop: 'loop',
                    config: {
                        fields: [
                            { target: 'page', value: '($page ?? 0) + 1', expression: true },
                            { target: 'i', value: '$_loopIndex', expression: true },
                        ],
                    },
                },
                {
                    id: 'fetch',
                    type: 'http-request',
                    label: 'Fetch',
                    loop: 'loop',
                    outputKey: 'response',
                    config: { method: 'GET', url: { value: '`https://api.test/${$name}/${$page}`', expression: true } },
                },
                { id: 'next', type: 'continue', label: 'Next', loop: 'loop', config: {} },
            ],
            edges: [
                { source: 'loop', sourcePort: 'iteration-start', target: 'page', targetPort: 'in-0' },
                { source: 'page', sourcePort: 'out-0', target: 'fetch', targetPort: 'in-0' },
                { source: 'fetch', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
                { source: 'page', sourcePort: 'out-0', target: 'next', targetPort: 'in-0' },
            ],
        },
    );

/** answers 200 {} after `delayMs` (0: at once, no timer) */
function fakeServer(delayMs = 5) {
    let inFlight = 0;
    const server = {
        most: 0,
        urls: [] as string[],
        send: async ({ url }: { url: string }) => {
            server.urls.push(url);
            inFlight += 1;
            server.most = Math.max(server.most, inFlight);
            await (delayMs ? new Promise(resolve => setTimeout(resolve, delayMs)) : Promise.resolve());
            inFlight -= 1;
            return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
        },
    };
    return server;
}

const names = (n: number) => Array.from({ length: n }, (_, k) => ({ name: `E${k}` }));
const pagesOf = (reached: Record<string, unknown>[], name: string) => reached.filter(d => d.name === name).map(d => [d.page, d.i]);

test('with the parallel switch on, the loops of the input envelopes run at the same time, never more than 10 at once', async () => {
    const server = fakeServer();
    const { record, reached } = await run(fetching(true), names(25), { http: server.send });
    expect(record.status).toBe('completed');
    expect(server.most).toBe(10);
    expect(server.urls).toHaveLength(50);
    expect(reached).toHaveLength(50);
    // each loop has its own loop state (the page Continue carries) and its own $_loopIndex
    for (const { name } of names(25)) {
        expect(pagesOf(reached, name)).toEqual([
            [1, 0],
            [2, 1],
        ]);
    }
});

test('with the parallel switch off (the default), one loop runs at a time, in arrival order', async () => {
    for (const parallel of [undefined, false]) {
        const server = fakeServer();
        const { reached } = await run(fetching(parallel), names(3), { http: server.send });
        expect(server.most).toBe(1);
        expect(reached.map(d => [d.name, d.page])).toEqual([
            ['E0', 1],
            ['E0', 2],
            ['E1', 1],
            ['E1', 2],
            ['E2', 1],
            ['E2', 2],
        ]);
    }
});

test('with the parallel switch on, what reaches Iteration end goes out as it arrives, the loops interleaved', async () => {
    const { reached } = await run(fetching(true), names(3), { http: fakeServer().send });
    expect(reached.map(d => [d.name, d.page])).toEqual([
        ['E0', 1],
        ['E1', 1],
        ['E2', 1],
        ['E0', 2],
        ['E1', 2],
        ['E2', 2],
    ]);
});

test("with the parallel switch on, a failed loop is the Loop's error for its input envelope (On error), the others go on", async () => {
    const parallel = { ...threeIterations, parallel: true };
    const goesOn = await run(loopFlow({ ...parallel, onError: 'continue' }, failing()), [{ name: 'A' }, { name: 'B' }]);
    expect(goesOn.loop.status).toBe('with-errors');
    expect(goesOn.loop.logs.filter(l => l.level === 'error')).toHaveLength(2);
    expect(goesOn.reached).toEqual([{ name: 'A', i: 0, ok: true }, { name: 'B', i: 0, ok: true }, { name: 'A' }, { name: 'B' }]);

    const divert = loopFlow({ ...parallel, onError: 'divert' }, failing());
    divert.edges.push({ source: 'loop', sourcePort: 'error', target: 'end', targetPort: 'in-0' });
    const diverted = await run(divert, [{ name: 'A' }, { name: 'B' }]);
    expect(diverted.record.status).toBe('completed');
    const withError = (name: string) => ({
        name,
        errors: [expect.objectContaining({ message: expect.stringContaining('iteration 1 failed'), component: 'Loop' })],
    });
    expect(diverted.reached).toEqual([{ name: 'A', i: 0, ok: true }, { name: 'B', i: 0, ok: true }, withError('A'), withError('B')]);

    const thrown = await run(loopFlow(parallel, failing()), [{ name: 'A' }, { name: 'B' }]);
    expect(thrown.record.status).toBe('failed');
    expect(thrown.record.error).toContain('iteration 1 failed');
    // what went out before the error stays out
    expect(thrown.reached).toEqual([
        { name: 'A', i: 0, ok: true },
        { name: 'B', i: 0, ok: true },
    ]);
});

test('with the parallel switch on, a loop that fails the run stops the other loops with it', async () => {
    // Fail (it throws in iteration 5 of A) → Fetch → Continue: fast iterations that send nothing out of the Loop
    const wf = loopFlow(
        { maxIterations: 300, parallel: true },
        {
            nodes: [
                {
                    id: 'fail',
                    type: 'mapper',
                    label: 'Fail',
                    loop: 'loop',
                    config: {
                        fields: [
                            {
                                target: 'ok',
                                value: "$name === 'A' && $_loopIndex === 5 ? (() => { throw new Error('A failed'); })() : true",
                                expression: true,
                            },
                        ],
                    },
                },
                {
                    id: 'fetch',
                    type: 'http-request',
                    label: 'Fetch',
                    loop: 'loop',
                    outputKey: 'response',
                    config: { method: 'GET', url: { value: '`https://api.test/${$name}`', expression: true } },
                },
                { id: 'next', type: 'continue', label: 'Next', loop: 'loop', config: {} },
            ],
            edges: [
                { source: 'loop', sourcePort: 'iteration-start', target: 'fail', targetPort: 'in-0' },
                { source: 'fail', sourcePort: 'out-0', target: 'fetch', targetPort: 'in-0' },
                { source: 'fetch', sourcePort: 'out-0', target: 'next', targetPort: 'in-0' },
            ],
        },
    );
    const server = fakeServer(0);
    const { record } = await run(wf, [{ name: 'A' }, { name: 'B' }, { name: 'C' }], { http: server.send });
    expect(record.status).toBe('failed');
    expect(record.error).toContain('A failed');
    const atTheEnd = server.urls.length;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(server.urls.length).toBe(atTheEnd);
    expect(server.urls.length).toBeLessThan(100);
});

/**
 * Nested Loops: the Loop runs Iteration start → Mark (outer = $_loopIndex) → an inner Loop → Iteration end; the inner
 * Loop's region is given (its nodes name `inner`), by default Index (i = $_loopIndex).
 */
const nested = (
    outer: Record<string, unknown>,
    inner: Record<string, unknown>,
    innerRegion: { nodes: ExecutableNode[]; edges: ExecutableFlow['edges'] } = {
        nodes: [
            {
                id: 'index',
                type: 'mapper',
                label: 'Index',
                loop: 'inner',
                config: { fields: [{ target: 'i', value: '$_loopIndex', expression: true }] },
            },
        ],
        edges: [
            { source: 'inner', sourcePort: 'iteration-start', target: 'index', targetPort: 'in-0' },
            { source: 'index', sourcePort: 'out-0', target: 'inner', targetPort: 'iteration-end' },
        ],
    },
    before: { nodes: ExecutableNode[]; edges: ExecutableFlow['edges'] } = {
        nodes: [],
        edges: [{ source: 'loop', sourcePort: 'iteration-start', target: 'mark', targetPort: 'in-0' }],
    },
) =>
    loopFlow(outer, {
        nodes: [
            ...before.nodes,
            {
                id: 'mark',
                type: 'mapper',
                label: 'Mark',
                loop: 'loop',
                config: { fields: [{ target: 'outer', value: '$_loopIndex', expression: true }] },
            },
            { id: 'inner', type: 'loop', label: 'Inner', loop: 'loop', config: inner },
            ...innerRegion.nodes,
        ],
        edges: [
            ...before.edges,
            { source: 'mark', sourcePort: 'out-0', target: 'inner', targetPort: 'in-0' },
            { source: 'inner', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
            ...innerRegion.edges,
        ],
    });

test('a Loop inside a loop region runs its own loop for every envelope that reaches it, in every iteration of the outer Loop', async () => {
    const split = {
        nodes: [{ id: 'split', type: 'split', label: 'Split', loop: 'loop', config: { list: '$items' } }],
        edges: [
            { source: 'loop', sourcePort: 'iteration-start', target: 'split', targetPort: 'in-0' },
            { source: 'split', sourcePort: 'out-0', target: 'mark', targetPort: 'in-0' },
        ],
    };
    const { record, reached } = await run(
        nested(
            { maxIterations: 100, stopCondition: '$_loopIndex >= 2' },
            { maxIterations: 100, stopCondition: '$_loopIndex >= 3' },
            undefined,
            split,
        ),
        [{ items: [{ n: 1 }, { n: 2 }] }],
    );
    expect(record.status).toBe('completed');
    // each component sees the $_loopIndex of the Loop that holds it directly, and each stop condition its own Loop's
    expect(reached).toEqual([
        { n: 1, outer: 0, i: 0 },
        { n: 1, outer: 0, i: 1 },
        { n: 1, outer: 0, i: 2 },
        { n: 2, outer: 0, i: 0 },
        { n: 2, outer: 0, i: 1 },
        { n: 2, outer: 0, i: 2 },
        { n: 1, outer: 1, i: 0 },
        { n: 1, outer: 1, i: 1 },
        { n: 1, outer: 1, i: 2 },
        { n: 2, outer: 1, i: 0 },
        { n: 2, outer: 1, i: 1 },
        { n: 2, outer: 1, i: 2 },
    ]);
});

test('Continue and Break act on the Loop that holds them directly', async () => {
    // inside the inner Loop: Count (count + 1) → Iteration end, → Continue, and → Break from the second count
    const counter = {
        nodes: [
            {
                id: 'count',
                type: 'mapper',
                label: 'Count',
                loop: 'inner',
                config: { fields: [{ target: 'count', value: '$count + 1', expression: true }] },
            },
            { id: 'next', type: 'continue', label: 'Next', loop: 'inner', config: {} },
            { id: 'enough', type: 'filter', label: 'Enough', loop: 'inner', config: { condition: '$count >= 2' } },
            { id: 'stop', type: 'break', label: 'Stop', loop: 'inner', config: {} },
        ],
        edges: [
            { source: 'inner', sourcePort: 'iteration-start', target: 'count', targetPort: 'in-0' },
            { source: 'count', sourcePort: 'out-0', target: 'inner', targetPort: 'iteration-end' },
            { source: 'count', sourcePort: 'out-0', target: 'next', targetPort: 'in-0' },
            { source: 'count', sourcePort: 'out-0', target: 'enough', targetPort: 'in-0' },
            { source: 'enough', sourcePort: 'out-0', target: 'stop', targetPort: 'in-0' },
        ],
    };
    const { record, reached, loop } = await run(nested({ maxIterations: 3 }, { maxIterations: 100 }, counter), [{ count: 0 }]);
    // the inner Break ends the inner loop only (the outer one runs to its max); the inner Continue carries the inner
    // loop state, so every outer iteration starts counting from the same outer loop state
    expect(loop.status).toBe('with-warnings');
    expect(record.status).toBe('with-warnings');
    expect(reached).toEqual([
        { count: 1, outer: 0 },
        { count: 2, outer: 0 },
        { count: 1, outer: 1 },
        { count: 2, outer: 1 },
        { count: 1, outer: 2 },
        { count: 2, outer: 2 },
    ]);
});

test('Next ends the iteration right away, without failing it; the next one starts with the same loop state', async () => {
    // Index → Slow (300 ms) → Iteration end; Index → Odd ($_loopIndex odd) → Next: the odd iterations end before Slow
    const wf = loopFlow(
        { maxIterations: 100, stopCondition: '$_loopIndex >= 4' },
        {
            nodes: [
                {
                    id: 'index',
                    type: 'mapper',
                    label: 'Index',
                    loop: 'loop',
                    config: { fields: [{ target: 'i', value: '$_loopIndex', expression: true }] },
                },
                { id: 'slow', type: 'typescript', label: 'Slow', loop: 'loop', config: { code: 'async function process($input) {}' } },
                { id: 'odd', type: 'filter', label: 'Odd', loop: 'loop', config: { condition: '$_loopIndex % 2 === 1' } },
                { id: 'skip', type: 'next', label: 'Skip', loop: 'loop', config: {} },
            ],
            edges: [
                { source: 'loop', sourcePort: 'iteration-start', target: 'index', targetPort: 'in-0' },
                { source: 'index', sourcePort: 'out-0', target: 'slow', targetPort: 'in-0' },
                { source: 'slow', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
                { source: 'index', sourcePort: 'out-0', target: 'odd', targetPort: 'in-0' },
                { source: 'odd', sourcePort: 'out-0', target: 'skip', targetPort: 'in-0' },
            ],
        },
    );
    const prepareScript = async () => async (input: unknown) => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return input;
    };
    const { record, reached, loop } = await run(wf, [{ name: 'A' }], { prepareScript, mode: 'validation' });
    expect(record.status).toBe('completed');
    expect(loop.status).toBe('completed');
    // the loop state never changed (no Continue with): each iteration started from { name: 'A' }
    expect(reached.map(d => d.i)).toEqual([0, 2]);
    expect(reached.every(d => d.name === 'A')).toBe(true);
    expect(loop.subRuns?.map(sub => sub.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
});
