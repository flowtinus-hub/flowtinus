import { describe, expect, test } from 'bun:test';
import { flowRunner, type ComponentRun, type ExecutableFlow, type RunRecord } from '@flowtinus/core';
import { evaluate } from '#shared/runner/evaluate';
import { findSubRun, MAX_ENVELOPE_CHARS, MAX_OUTPUT_CHARS, runOutputPage, runSummary, shrinkJson, subRunPathOf, subRunSummaryView } from '#features/mcp/run-summary';
import type { RunView } from '#features/runs/get-run/get-run-handler';

/*
 * The MCP's run summary and what it reads from a run's record: envelopes shrunk to valid JSON, a page of whole
 * envelopes (get_run_output), the calls of a Flow Invoker (subRuns) and a called flow's run read from its caller's
 * record (subRunId), what a database component wrote (writes).
 */

const view = (record: RunRecord, id = 'r1', flowId = 'f1'): RunView =>
    ({ id, flowId, mode: 'validation', status: record.status, record }) as unknown as RunView;

const component = (c: Partial<ComponentRun> & { nodeId: string }): ComponentRun => ({
    label: c.nodeId,
    type: 'mapper',
    status: 'completed',
    inputs: {},
    outputs: {},
    logs: [],
    inputSample: [],
    outputSample: {},
    ...c,
});

const record = (components: ComponentRun[]): RunRecord => ({
    run: { id: 'r1', mode: 'validation', workspace: 'w', project: 'P', flow: 'F', startedAt: '2026-11-09T00:00:00Z' },
    parameters: {},
    status: 'completed',
    end: '2026-11-09T00:00:01Z',
    durationMs: 1000,
    components,
});

describe('an envelope too large for the summary is shrunk, still valid JSON, each cut marked', () => {
    test('long lists keep their first items, texts their start, objects their first keys', () => {
        const data = {
            columns: Array.from({ length: 400 }, (_, i) => ({ table: `t${i}`, column: `c${i}`, type: 'character varying(256)' })),
            note: 'n'.repeat(5000),
        };
        const { value, shrunk } = shrinkJson(data, MAX_ENVELOPE_CHARS);
        expect(shrunk).toBe(true);
        const text = JSON.stringify(value);
        expect(text.length).toBeLessThanOrEqual(MAX_ENVELOPE_CHARS);
        // valid JSON, the same shape: a list that says how many items it left out, a text how many characters
        const back = JSON.parse(text) as { columns: unknown[]; note: string };
        expect(back.columns[0]).toEqual({ table: 't0', column: 'c0', type: 'character varying(256)' });
        expect(back.columns.at(-1)).toMatch(/^…\+\d+ items$/);
        expect(back.note).toMatch(/^n+…\+\d+ chars$/);
    });

    test('what fits is left as it is; an object of many keys keeps the first ones and says how many more', () => {
        expect(shrinkJson({ a: 1 }, 100)).toEqual({ value: { a: 1 }, shrunk: false });
        const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`key${i}`, i]));
        const { value } = shrinkJson(wide, 2000);
        expect((value as Record<string, unknown>)['…']).toMatch(/^\+\d+ keys$/);
        // nothing small enough: only its size
        expect(shrinkJson({ x: 'y'.repeat(1000) }, 10)).toEqual({ value: '…1008 chars of JSON', shrunk: true });
    });

    test("the summary's sample counts what it shrank", () => {
        const big = component({ nodeId: 'big', outputs: { 'out-0': 1 }, outputSample: { 'out-0': [{ text: 'x'.repeat(20_000) }] } });
        const [summary] = runSummary(view(record([big])), 3).components;
        expect(summary!.shrunk).toBe(1);
        expect(summary!.sample!['out-0']![0]).toEqual({ text: `${'x'.repeat(2000)}…+18000 chars` });
    });
});

describe('get_run_output: whole envelopes of one port, a page at a time', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ i }));
    const rec = record([
        component({ nodeId: 'q', outputs: { 'out-0': 120, error: 0 }, outputSample: { 'out-0': items } }),
        component({ nodeId: 'end', type: 'end', inputs: { 'in-0': 3 }, inputSample: [{ a: 1 }, { a: 2 }, { a: 3 }] }),
    ]);

    test('says how many went through, how many the record has and how many it does not; next is the following page', () => {
        const page = runOutputPage(rec, { runId: 'r1', nodeId: 'q', offset: 0, limit: 20 });
        expect(page.ok).toBe(true);
        if (!page.ok) {
            return;
        }
        expect(page.value).toMatchObject({ port: 'out-0', total: 120, inRecord: 50, leftOut: 70, offset: 0, next: 20 });
        expect(page.value.envelopes).toEqual(items.slice(0, 20));
        const last = runOutputPage(rec, { runId: 'r1', nodeId: 'q', port: 'out-0', offset: 40, limit: 20 });
        expect(last.ok && last.value.envelopes).toEqual(items.slice(40));
        expect(last.ok && last.value.next).toBeUndefined();
    });

    test("the End's input is what reached it; an unknown port or component says what there is", () => {
        const end = runOutputPage(rec, { runId: 'r1', nodeId: 'end', offset: 1, limit: 10 });
        expect(end.ok && end.value).toMatchObject({ port: 'input', total: 3, inRecord: 3, leftOut: 0, envelopes: [{ a: 2 }, { a: 3 }] });
        expect(runOutputPage(rec, { runId: 'r1', nodeId: 'q', port: 'nope', offset: 0, limit: 5 })).toEqual({
            ok: false,
            error: 'q has no port nope: its outputs are out-0, error; "input" reads what came in.',
        });
        expect(runOutputPage(rec, { runId: 'r1', nodeId: 'x', offset: 0, limit: 5 })).toEqual({
            ok: false,
            error: 'No component x in this run (its components: q, end).',
        });
    });

    test('a page stops before it takes more than MAX_OUTPUT_CHARS; one envelope larger than that alone comes shrunk', () => {
        const large = Array.from({ length: 3 }, (_, i) => ({ i, rows: 'r'.repeat(MAX_OUTPUT_CHARS / 2) }));
        const rows = record([component({ nodeId: 'q', outputs: { 'out-0': 3 }, outputSample: { 'out-0': large } })]);
        const page = runOutputPage(rows, { runId: 'r1', nodeId: 'q', offset: 0, limit: 10 });
        expect(page.ok && page.value.envelopes).toHaveLength(1);
        expect(page.ok && page.value.next).toBe(1);
        const huge = record([
            component({ nodeId: 'q', outputs: { 'out-0': 1 }, outputSample: { 'out-0': [{ rows: 'r'.repeat(MAX_OUTPUT_CHARS * 2) }] } }),
        ]);
        const one = runOutputPage(huge, { runId: 'r1', nodeId: 'q', offset: 0, limit: 10 });
        expect(one.ok && one.value.shrunk).toEqual([0]);
        expect(JSON.stringify(one.ok && one.value.envelopes[0]).length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    });
});

describe("a Flow Invoker's calls: listed in the summary, each one read from its caller's record", () => {
    const edge = (source: string, target: string, sourcePort = 'out-0') => ({ source, sourcePort, target, targetPort: 'in-0' });
    /** C: a Mapper that fails on a bad item */
    const leaf: ExecutableFlow = {
        id: 'C',
        project: 'Test',
        flow: 'Leaf',
        parameters: [],
        nodes: [
            { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
            {
                id: 'm',
                type: 'mapper',
                label: 'Check',
                config: {
                    onError: 'continue',
                    fields: [{ target: 'ok', value: "$bad ? (() => { throw new Error('bad ' + $n); })() : true", expression: true }],
                },
            },
            { id: 'end', type: 'end', label: 'End', config: {} },
        ],
        edges: [edge('start', 'm'), edge('m', 'end')],
    };
    /** B and A: each calls the next one with its envelope */
    const caller = (id: string, name: string, calls: string): ExecutableFlow => ({
        id,
        project: 'Test',
        flow: name,
        parameters: [],
        nodes: [
            { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
            { id: 'call', type: 'flow', label: `Calls ${calls}`, config: { flowId: calls, sendEnvelope: true } },
            { id: 'end', type: 'end', label: 'End', config: {} },
        ],
        edges: [edge('start', 'call'), edge('call', 'end')],
    });
    const run = () =>
        flowRunner(caller('A', 'Top', 'B'), {
            mode: 'validation',
            id: 'r1',
            evaluate,
            input: [{ n: 1 }, { n: 2, bad: true }],
            flows: { B: caller('B', 'Middle', 'C'), C: leaf },
        });

    test('subRuns: id, flow, status, duration, envelopes at its End, its first error', async () => {
        const rec = await run();
        const call = runSummary(view(rec), 1).components.find(c => c.nodeId === 'call')!;
        expect(call.subRuns).toHaveLength(2);
        const [first, second] = rec.components.find(c => c.nodeId === 'call')!.subRuns!;
        expect(call.subRuns![0]).toMatchObject({ id: first!.id, flow: 'Middle', status: 'completed', envelopesAtEnd: 1 });
        expect(call.subRuns![1]).toMatchObject({ id: second!.id, flow: 'Middle', status: 'completed', envelopesAtEnd: 1 });
        expect(call.subRuns![0]!.durationMs).toBeGreaterThanOrEqual(0);
        expect(call.subRuns![0]!.firstError).toBeUndefined();
    });

    test('get_run with subRunId: the child, and with a path the grandchild, summarized the same way', async () => {
        const rec = await run();
        const child = rec.components.find(c => c.nodeId === 'call')!.subRuns![1]!;
        const grandchild = child.record!.components.find(c => c.nodeId === 'call')!.subRuns![0]!;
        const one = findSubRun(rec, subRunPathOf(child.id));
        expect(one.ok).toBe(true);
        if (!one.ok) {
            return;
        }
        const middle = subRunSummaryView(view(rec), one.value, 1);
        expect(middle).toMatchObject({ runId: 'r1', flow: 'Middle', subRunPath: [child.id], status: 'completed' });
        // its own call: the leaf, with errors, its first one
        expect(middle.components.find(c => c.nodeId === 'call')!.subRuns).toEqual([
            {
                id: grandchild.id,
                flow: 'Leaf',
                status: 'with-errors',
                durationMs: grandchild.durationMs,
                envelopesAtEnd: 1,
                firstError: expect.stringMatching(/^"Check": .*bad 2/),
            },
        ]);
        const two = findSubRun(rec, subRunPathOf([child.id, grandchild.id]));
        expect(two.ok).toBe(true);
        if (!two.ok) {
            return;
        }
        const leafView = subRunSummaryView(view(rec), two.value, 1);
        expect(leafView).toMatchObject({ flow: 'Leaf', status: 'with-errors', subRunPath: [child.id, grandchild.id] });
        expect(leafView.components.find(c => c.nodeId === 'm')).toMatchObject({
            errors: 1,
            errorMessages: [expect.stringContaining('bad 2')],
        });
        // and its envelopes, as get_run_output reads them
        const end = runOutputPage(two.value.record, { runId: 'r1', nodeId: 'end', offset: 0, limit: 5, subRunPath: two.value.path });
        expect(end.ok && end.value).toMatchObject({ subRunPath: [child.id, grandchild.id], port: 'input', total: 1 });
    });

    test('a sub-run that is not there says which calls there are', async () => {
        const rec = await run();
        const found = findSubRun(rec, ['nope']);
        expect(found.ok).toBe(false);
        expect(!found.ok && found.error).toMatch(/^No call nope in the run: its calls are .+ \(Middle\)/);
    });
});

test('the summary has what a database component wrote, per table', () => {
    const writes = { 'df.briefs': { inserted: 2, updated: 0, deleted: 0, affected: 2, batches: 1, failed: 0 } };
    const [summary] = runSummary(view(record([component({ nodeId: 'w', type: 'redshift-insert', writes })])), 0).components;
    expect(summary!.writes).toEqual(writes);
    const [none] = runSummary(view(record([component({ nodeId: 'm' })])), 0).components;
    expect(none!.writes).toBeUndefined();
});
