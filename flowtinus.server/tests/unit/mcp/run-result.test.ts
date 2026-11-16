import { expect, test } from 'bun:test';
import { flowRunner, type ExecutableFlow } from '@flowtinus/core';
import { evaluate } from '#shared/runner/evaluate';
import { runAnswer, subRunAnswer } from '#features/mcp/run-result';
import { findSubRun } from '#features/mcp/run-summary';
import type { RunView } from '#features/runs/get-run/get-run-handler';

/** Start → Mapper (soma = 40 + 2) → End */
const sum: ExecutableFlow = {
    project: 'Test',
    flow: 'Sum',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: {} },
        { id: 'sum', type: 'mapper', label: 'Sum', config: { fields: [{ target: 'soma', value: '40 + 2', expression: true }] } },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'sum', targetPort: 'in-0' },
        { source: 'sum', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
};

const viewOf = (record: unknown, status: RunView['status'] = (record as { status: RunView['status'] }).status) =>
    ({ id: 'r1', flowId: 'f1', mode: 'validation', status, record }) as unknown as RunView;

const run = async (flow: ExecutableFlow) => viewOf(await flowRunner(flow, { mode: 'validation', id: 'r1', evaluate }));

test('a clean run answers its run result: status, output and its count, nothing else', async () => {
    const answer = runAnswer(await run(sum), { sample: 3 });
    expect(answer).toEqual({ runId: 'r1', status: 'completed', durationMs: expect.any(Number), output: [{ soma: 42 }], outputCount: 1 });
});

/** Start → Mapper reading $a.b (fails on every envelope), with this error policy → End */
const failing = (onError: 'continue' | 'divert'): ExecutableFlow => ({
    ...sum,
    nodes: sum.nodes.map(n =>
        n.id === 'sum' ? { ...n, config: { onError, fields: [{ target: 'x', value: '$a.b', expression: true }] } } : n,
    ),
});

test.each(['continue', 'divert'] as const)('a run with an envelope in error (onError: %s) answers its run summary', async onError => {
    const answer = runAnswer(await run(failing(onError)), { sample: 3 });
    expect(answer).toMatchObject({ runId: 'r1', flowId: 'f1', components: expect.any(Array) });
});

/** a component of a record, as the engine leaves it */
const component = (nodeId: string, type: string, more: Record<string, unknown> = {}) => ({
    nodeId,
    label: nodeId,
    type,
    status: 'completed',
    inputs: {},
    outputs: {},
    logs: [],
    inputSample: [],
    outputSample: {},
    ...more,
});

const recordOf = (components: unknown[], status = 'completed') => ({ status, durationMs: 7, components });

test.each(['failed', 'cancelled', 'running', 'queued', 'with-warnings', 'with-errors'] as const)(
    'a run %s answers its run summary',
    status => {
        expect(runAnswer(viewOf(recordOf([component('end', 'end')]), status), { sample: 3 })).toHaveProperty('components');
    },
);

test('a completed run with a call that failed answers its run summary; a fire-and-forget call still going does not count', () => {
    const calling = (subRuns: unknown[]) => viewOf(recordOf([component('call', 'flow', { subRuns }), component('end', 'end')]));
    const failedCall = { id: 's1', flow: 'Child', status: 'failed', durationMs: 1, error: 'boom' };
    const goingOn = { id: 's2', flow: 'Child', status: 'queued', durationMs: 0, fireAndForget: true };
    expect(runAnswer(calling([failedCall]), { sample: 3 })).toHaveProperty('components');
    expect(runAnswer(calling([goingOn]), { sample: 3 })).not.toHaveProperty('components');
});

test("a completed call with an envelope in error, read from the caller's record, makes the run not clean", () => {
    const inner = recordOf([component('m', 'mapper', { logs: [{ at: '', level: 'error', message: 'x is not defined' }] })]);
    const call = { id: 's1', flow: 'Child', status: 'completed', durationMs: 1, record: inner };
    const view = viewOf(recordOf([component('call', 'flow', { subRuns: [call] }), component('end', 'end')]));
    expect(runAnswer(view, { sample: 3 })).toHaveProperty('components');
});

test('detail forces either shape', async () => {
    expect(runAnswer(await run(sum), { sample: 3, detail: 'summary' })).toHaveProperty('components');
    expect(runAnswer(await run(failing('continue')), { sample: 3, detail: 'result' })).toMatchObject({
        status: 'with-errors',
        outputCount: 1,
    });
});

test('output: up to `sample` of the envelopes at the End, shrunk when large; outputCount: all that reached it', () => {
    const big = { big: 'x'.repeat(20_000) };
    const end = component('end', 'end', { inputs: { 'in-0': 5 }, inputSample: [big, { n: 2 }, { n: 3 }] });
    expect(runAnswer(viewOf(recordOf([end])), { sample: 2 })).toEqual({
        runId: 'r1',
        status: 'completed',
        durationMs: 7,
        output: [{ big: `${'x'.repeat(2000)}…+18000 chars` }, { n: 2 }],
        outputCount: 5,
        shrunk: 1,
    });
});

const counts = (inserted: number, updated = 0) => ({ inserted, updated, deleted: 0, affected: inserted + updated, batches: 1, failed: 0 });

test('writes: what the whole run wrote, summed per table across components and calls', () => {
    const child = recordOf([component('save', 'postgres', { writes: { orders: counts(2) } })]);
    const view = viewOf(
        recordOf([
            component('a', 'postgres', { writes: { orders: counts(3), audit: counts(1) } }),
            component('b', 'postgres', { writes: { orders: counts(0, 4) } }),
            component('call', 'flow', { subRuns: [{ id: 's1', flow: 'Child', status: 'completed', durationMs: 1, record: child }] }),
            component('end', 'end'),
        ]),
    );
    expect(runAnswer(view, { sample: 3 })).toMatchObject({
        writes: {
            orders: { inserted: 5, updated: 4, deleted: 0, affected: 9, batches: 3, failed: 0 },
            audit: counts(1),
        },
    });
});

test("logs: only the warnings and errors the user's components wrote; the engine's debug and info lines are left out", () => {
    const line = (level: string, message: string, byComponent?: true) => ({
        at: '',
        level,
        message,
        ...(byComponent ? { byComponent } : {}),
    });
    const script = component('script', 'typescript', {
        label: 'Script',
        logs: [
            line('debug', 'debug: 1 envelope(s) in and 1 out.'),
            line('info', 'hello', true),
            line('warning', 'stock is low', true),
            line('error', 'price missing', true),
        ],
    });
    const end = component('end', 'end', { logs: [line('debug', 'Run r1 finished (completed) in 1 ms.')] });
    expect(runAnswer(viewOf(recordOf([script, end])), { sample: 3 })).toMatchObject({
        logs: ['warning (Script): stock is low', 'error (Script): price missing'],
    });
});

test("a sub-run read through get_run's subRunId answers the same way: its run result when clean, its summary otherwise", () => {
    const child = (status: string) => recordOf([component('end', 'end', { inputs: { 'in-0': 1 }, inputSample: [{ ok: true }] })], status);
    const parent = (status: string) =>
        viewOf(
            recordOf([component('call', 'flow', { subRuns: [{ id: 's1', flow: 'Child', status, durationMs: 4, record: child(status) }] })]),
        );
    const answerFor = (status: string) => {
        const view = parent(status);
        const found = findSubRun(view.record, ['s1']);
        if (!found.ok) {
            throw new Error(found.error);
        }
        return subRunAnswer(view, found.value, { sample: 3 });
    };
    expect(answerFor('completed')).toEqual({ runId: 'r1', status: 'completed', durationMs: 4, output: [{ ok: true }], outputCount: 1 });
    expect(answerFor('failed')).toMatchObject({ subRunPath: ['s1'], components: expect.any(Array) });
});

test('a completed run that diverted an envelope (onError: divert) while others reached the End is not clean', () => {
    const mapper = component('m', 'mapper', { inputs: { 'in-0': 2 }, outputs: { 'out-0': 1, error: 1 } });
    const end = component('end', 'end', { inputs: { 'in-0': 1 }, inputSample: [{ ok: true }] });
    expect(runAnswer(viewOf(recordOf([mapper, end])), { sample: 3 })).toHaveProperty('components');
});

test("a Log at level warn leaves the run clean: its line comes in the run result's logs", async () => {
    const warned: ExecutableFlow = {
        ...sum,
        nodes: [...sum.nodes, { id: 'log', type: 'log', label: 'Check', config: { level: 'warn', message: "'stock is low'" } }],
        edges: [
            { source: 'start', sourcePort: 'out-0', target: 'log', targetPort: 'in-0' },
            { source: 'log', sourcePort: 'out-0', target: 'sum', targetPort: 'in-0' },
            { source: 'sum', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        ],
    };
    expect(runAnswer(await run(warned), { sample: 3 })).toMatchObject({ status: 'completed', logs: ['warning (Check): stock is low'] });
});
