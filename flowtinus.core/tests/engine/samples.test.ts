import { describe, expect, test } from 'bun:test';
import { flowRunner, planRunFrom, type ComponentRun, type ExecutableFlow } from '../../src/index';
import { samplesWithin } from '../../src/engine/progress-samples';
import { evaluate } from '../helpers';

/** Start → Mapper (adds one field) → End */
const flow = (): ExecutableFlow => ({
    project: 'Test',
    flow: 'Samples',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
        { id: 'm', type: 'mapper', label: 'Mapper', config: { fields: [{ target: 'seen', value: 'true', expression: true }] } },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'm', targetPort: 'in-0' },
        { source: 'm', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

const big = (n: number, kib: number) => ({ n, text: 'x'.repeat(kib * 1024) });

describe("a run's record keeps whole envelopes in its samples up to a size per component; the rest only counted", () => {
    test('an envelope larger than a component keeps: none of the components keeps it (the End does), every one goes on', async () => {
        const record = await flowRunner(flow(), { mode: 'execution', id: 's1', evaluate, input: [{ n: 1 }, big(2, 1200), { n: 3 }] });
        expect(record.status).toBe('completed');
        const m = record.components.find(c => c.nodeId === 'm')!;
        // the first that does not fit ends the sample: the small one after it is counted, not kept
        expect(m.inputSample).toEqual([{ n: 1 }]);
        expect(m.outputSample['out-0']).toEqual([{ n: 1, seen: true }]);
        expect(m.samplesNotKept).toEqual({ input: 2, output: 2 });
        expect(m.outputs).toEqual({ 'out-0': 3 });
        // the End has its own size (what a webhook that waits answers with): all of it
        const end = record.components.find(c => c.nodeId === 'end')!;
        expect(end.inputSample.map(e => e.n)).toEqual([1, 2, 3]);
        expect(end.samplesNotKept).toBeUndefined();
    });

    test("a component's samples share its size: what its input took, its output does not have", async () => {
        const record = await flowRunner(flow(), { mode: 'execution', id: 's2', evaluate, input: [{ n: 1 }, big(2, 700), { n: 3 }] });
        const m = record.components.find(c => c.nodeId === 'm')!;
        expect(m.inputSample.map(e => e.n)).toEqual([1, 2, 3]);
        expect(m.outputSample['out-0']).toEqual([{ n: 1, seen: true }]);
        expect(m.samplesNotKept).toEqual({ input: 0, output: 2 });
    });

    test('only the first SAMPLE_SIZE envelopes count: a long run of small ones leaves nothing out', async () => {
        const many = Array.from({ length: 80 }, (_, n) => ({ n }));
        const small = await flowRunner(flow(), { mode: 'execution', id: 's3', evaluate, input: many });
        expect(small.components.every(c => c.samplesNotKept === undefined)).toBe(true);
        expect(small.components.find(c => c.nodeId === 'm')!.inputSample).toHaveLength(50);

        const after = await flowRunner(flow(), { mode: 'execution', id: 's4', evaluate, input: [big(0, 1200), ...many] });
        expect(after.components.find(c => c.nodeId === 'm')!.samplesNotKept).toEqual({ input: 50, output: 50 });
    });

    test('Run from here: refused for a component whose input the record did not keep, as it is for one it did', async () => {
        const wf = flow();
        const cut = await flowRunner(wf, { mode: 'execution', id: 's5', evaluate, input: [{ n: 1 }, big(2, 1200)] });
        expect(planRunFrom(wf, 'm', cut.components)).toEqual({
            ok: false,
            error: 'The last run did not keep what reached "Mapper" (envelopes too big for its record): run the flow first.',
        });
        expect(planRunFrom(wf, 'end', cut.components).ok).toBe(true);

        const whole = await flowRunner(wf, { mode: 'execution', id: 's6', evaluate, input: [{ n: 1 }, { n: 2 }] });
        expect(planRunFrom(wf, 'm', whole.components).ok).toBe(true);
    });
});

describe("a called flow's record in the caller's: 64 KiB of whole envelopes per component, and a total for them all", () => {
    /** Start → Flow Invoker (calls `child` per envelope, waits) → End; child: Start → Mapper → End */
    const caller = (): { wf: ExecutableFlow; child: ExecutableFlow } => ({
        wf: {
            project: 'Test',
            flow: 'Caller',
            parameters: [],
            nodes: [
                { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
                { id: 'call', type: 'flow', label: 'Call', config: { flowId: 'child', call: 'wait', sendEnvelope: true, parameters: [] } },
                { id: 'end', type: 'end', label: 'End', config: {} },
            ],
            edges: [
                { source: 'start', sourcePort: 'out-0', target: 'call', targetPort: 'in-0' },
                { source: 'call', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
            ],
        },
        child: { ...flow(), id: 'child', flow: 'Child' },
    });

    test('an envelope past 64 KiB is in no sample of the call (its End neither); the caller gets it whole', async () => {
        const { wf, child } = caller();
        const record = await flowRunner(wf, {
            mode: 'execution',
            id: 'c1',
            evaluate,
            input: [{ n: 1 }, big(2, 100)],
            flows: { child },
        });
        expect(record.status).toBe('completed');
        const subRuns = record.components.find(c => c.nodeId === 'call')!.subRuns!;
        expect(subRuns).toHaveLength(2);
        const small = subRuns[0]!.record!.components;
        expect(small.find(c => c.nodeId === 'end')!.inputSample).toEqual([{ n: 1, seen: true }]);
        expect(small.every(c => c.samplesNotKept === undefined)).toBe(true);
        const large = subRuns[1]!.record!.components;
        for (const c of large) {
            expect(c.inputSample).toEqual([]);
        }
        expect(large.find(c => c.nodeId === 'end')!.samplesNotKept).toEqual({ input: 1, output: 0 });
        // the data itself goes on: the caller's End (10 MiB) has it whole
        const end = record.components.find(c => c.nodeId === 'end')!;
        expect(end.inputSample.map(e => e.n)).toEqual([1, 2]);
        expect((end.inputSample[1]!.text as string).length).toBe(100 * 1024);
    });

    const component = (nodeId: string, kib: number): ComponentRun => ({
        nodeId,
        label: nodeId,
        type: 'mapper',
        status: 'completed',
        inputs: { 'in-0': 1 },
        outputs: {},
        logs: [],
        inputSample: [{ text: 'x'.repeat(kib * 1024) }],
        outputSample: {},
    });

    test('the total is spent as the calls end: past it, a record keeps its counts and logs, no samples', () => {
        const total = { bytes: 100 * 1024 };
        const sizes = { perComponent: 64 * 1024, perSubRunComponent: 64 * 1024, total };
        const first = samplesWithin([component('a', 40), component('b', 40)], sizes);
        const second = samplesWithin([component('a', 40)], sizes);
        expect(first.map(c => c.inputSample.length)).toEqual([1, 1]);
        expect(second[0]!.inputSample).toEqual([]);
        expect(second[0]!.samplesNotKept).toEqual({ input: 1, output: 0 });
        expect(second[0]!.inputs).toEqual({ 'in-0': 1 });
        expect(total.bytes).toBeLessThan(40 * 1024);
    });
});
