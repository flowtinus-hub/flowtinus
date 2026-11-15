import { describe, expect, test } from 'bun:test';
import { flowRunner, type ComponentRun, type EnvelopeData, type RunProgress, type SubRun } from '../../src/index';
import { progressComponents } from '../../src/engine/progress-samples';
import { evaluate } from '../helpers';

test("a run's progress: each component's status as it goes (running, then how it ended), counts so far; the final record has no running", async () => {
    const seen: RunProgress[] = [];
    const record = await flowRunner(
        {
            project: 'Test',
            flow: 'Slow',
            parameters: [],
            nodes: [
                { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
                { id: 'h', type: 'http-request', label: 'Slow API', config: { url: { value: 'https://api.test/x', expression: false } } },
                { id: 'end', type: 'end', label: 'End', config: {} },
            ],
            edges: [
                { source: 'start', sourcePort: 'out-0', target: 'h', targetPort: 'in-0' },
                { source: 'h', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
            ],
        },
        {
            mode: 'validation',
            id: 'p1',
            evaluate,
            input: [{ n: 1 }],
            http: async () => {
                await new Promise(resolve => setTimeout(resolve, 700));
                return { status: 200, headers: {}, body: '{}' };
            },
            onProgress: progress => void seen.push(progress),
        },
    );

    expect(seen.length).toBeGreaterThan(1);
    const status = (p: RunProgress, id: string) => p.components.find(c => c.nodeId === id)!.status;
    // while the API is slow: the Start already done (1 out), the HTTP Request running
    const during = seen.find(p => status(p, 'h') === 'running')!;
    expect(during.status).toBe('running');
    expect(status(during, 'start')).toBe('completed');
    expect(during.components.find(c => c.nodeId === 'start')!.outputs).toEqual({ 'out-0': 1 });
    expect(during.components.find(c => c.nodeId === 'h')!.outputs).toEqual({});
    expect(record.components.every(c => c.status !== 'running')).toBe(true);
    expect(record.components.find(c => c.nodeId === 'h')!.outputs).toEqual({ 'out-0': 1 });
});

describe("the progress' samples: whole envelopes up to a size, the rest counted; the final record keeps them all", () => {
    const big = (n: number) => ({ n, text: 'x'.repeat(300 * 1024) });

    test('a component whose envelopes pass its size: the first ones that fit, the others counted in samplesNotKept', async () => {
        const seen: RunProgress[] = [];
        const record = await flowRunner(
            {
                project: 'Test',
                flow: 'Big envelopes',
                parameters: [],
                nodes: [
                    { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
                    {
                        id: 'h',
                        type: 'http-request',
                        label: 'Slow API',
                        config: { url: { value: 'https://api.test/x', expression: false } },
                    },
                    { id: 'end', type: 'end', label: 'End', config: {} },
                ],
                edges: [
                    { source: 'start', sourcePort: 'out-0', target: 'h', targetPort: 'in-0' },
                    { source: 'h', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
                ],
            },
            {
                mode: 'execution',
                id: 'p2',
                evaluate,
                input: [{ n: 1 }, big(2), { n: 3 }],
                http: async () => {
                    await new Promise(resolve => setTimeout(resolve, 700));
                    return { status: 200, headers: {}, body: '{}' };
                },
                onProgress: progress => void seen.push(progress),
            },
        );

        // while the API is slow, once the 3 envelopes reached it
        const during = seen.findLast(p => p.components.find(c => c.nodeId === 'h')!.inputs['in-0'] === 3)!;
        expect(during.components.find(c => c.nodeId === 'h')!.status).toBe('running');
        const start = during.components.find(c => c.nodeId === 'start')!;
        // the big one does not fit, and ends the sample (a sample is the first envelopes, in order)
        expect(start.outputSample['out-0']).toEqual([{ n: 1 }]);
        // (the Start samples what it receives too: the same envelopes)
        expect(start.samplesNotKept).toEqual({ input: 2, output: 2 });
        expect(start.outputs).toEqual({ 'out-0': 3 });
        const h = during.components.find(c => c.nodeId === 'h')!;
        expect(h.inputSample).toEqual([{ n: 1 }]);
        // what it already sent on carries the big one too: left out there as well
        expect(h.samplesNotKept).toEqual({ input: 2, output: h.outputs['out-0']! - 1 });
        expect(h.outputSample['out-0']).toHaveLength(1);

        const final = record.components.find(c => c.nodeId === 'start')!;
        expect(final.outputSample['out-0']).toEqual([{ n: 1 }, big(2), { n: 3 }]);
        expect(record.components.every(c => c.samplesNotKept === undefined)).toBe(true);
    });

    const component = (nodeId: string, sample: EnvelopeData[], more: Partial<ComponentRun> = {}): ComponentRun => ({
        nodeId,
        label: nodeId,
        type: 'mapper',
        status: 'completed',
        inputs: { 'in-0': sample.length },
        outputs: { 'out-0': sample.length },
        logs: [],
        inputSample: sample,
        outputSample: { 'out-0': sample },
        ...more,
    });

    test('small samples go whole, the envelopes shared (not copied) and the lists new', () => {
        const sample = [{ n: 1 }, { n: 2 }];
        const [c] = progressComponents([component('m', sample)]);
        expect(c!.inputSample).toEqual(sample);
        expect(c!.inputSample).not.toBe(sample);
        expect(c!.inputSample[0]).toBe(sample[0]!);
        expect(c!.samplesNotKept).toBeUndefined();
    });

    test("a called flow's components get a smaller size; what its own progress left out adds up", () => {
        const piece = { text: 'y'.repeat(20 * 1024) };
        const sub: SubRun = {
            id: 's1',
            flow: 'Child',
            status: 'running',
            durationMs: 1,
            record: {
                run: { id: 's1', mode: 'execution', workspace: 'w', project: 'Test', flow: 'Child', startedAt: new Date().toISOString() },
                parameters: {},
                status: 'running',
                durationMs: 1,
                components: [component('child', [piece, piece], { samplesNotKept: { input: 3, output: 0 } })],
            },
        };
        const [c] = progressComponents([component('invoker', [{ n: 1 }], { subRuns: [sub] })]);
        const child = c!.subRuns![0]!.record!.components[0]!;
        // 32 KiB in a called flow: one piece of 20 KiB in the input, none left for the output
        expect(child.inputSample).toHaveLength(1);
        expect(child.outputSample['out-0']).toEqual([]);
        expect(child.samplesNotKept).toEqual({ input: 4, output: 2 });
        // the caller's own sample untouched, and the sub-run given back as a new record
        expect(c!.inputSample).toEqual([{ n: 1 }]);
        expect(sub.record!.components[0]!.inputSample).toHaveLength(2);
    });

    test('the whole progress has a total: past it, the components that follow carry no samples', () => {
        const piece = { text: 'z'.repeat(100 * 1024) };
        // 2 envelopes of 100 KiB in and 2 out: 2 fit in its 256 KiB; the 4 MiB total holds 20 such components
        const components = progressComponents(Array.from({ length: 30 }, (_, i) => component(`m${i}`, [piece, piece])));
        expect(components[0]!.inputSample).toHaveLength(2);
        expect(components[0]!.outputSample['out-0']).toHaveLength(0);
        expect(components[19]!.inputSample).toHaveLength(2);
        expect(components[20]!.inputSample).toHaveLength(0);
        expect(components[29]!.samplesNotKept).toEqual({ input: 2, output: 2 });
    });
});
