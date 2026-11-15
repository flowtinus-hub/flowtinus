import { expect, test } from 'bun:test';
import { errorOrigins, errorWithOrigin, flowRunner, rethrow, toError } from '../../src/index';
import type { ExecutableFlow, PrepareScript } from '../../src/index';
import { evaluate } from '../helpers';

/*
 * An error a component throws again, its cause another component's (a Wait's firstError): the run's error and the
 * component's line say where it began.
 */

/**
 * Start → hold of a Wait; Start → "Insert" (a Mapper that fails on a bad item, onError divert) → its output and error
 * port into watch; Wait → "Report page result" (a TypeScript: the stub below runs `code` as its process) → End.
 */
const flow = (report: Partial<ExecutableFlow['nodes'][number]> = {}): ExecutableFlow => ({
    project: 'Test',
    flow: 'Load page',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
        {
            id: 'insert',
            type: 'mapper',
            label: 'Insert',
            config: {
                onError: 'divert',
                fields: [{ target: 'ok', value: "$bad ? (() => { throw new Error('value too long'); })() : true", expression: true }],
            },
        },
        { id: 'wait', type: 'wait', label: 'Wait', config: {} },
        { id: 'report', type: 'typescript', label: 'Report page result', config: { code: 'async function process() {}' }, ...report },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'wait', targetPort: 'in-0' },
        { source: 'start', sourcePort: 'out-0', target: 'insert', targetPort: 'in-0' },
        { source: 'insert', sourcePort: 'out-0', target: 'wait', targetPort: 'in-1' },
        { source: 'insert', sourcePort: 'error', target: 'wait', targetPort: 'in-1' },
        { source: 'report', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        // its error port, when it diverts
        ...(report.config?.onError === 'divert' ? [{ source: 'report', sourcePort: 'error', target: 'end', targetPort: 'in-0' }] : []),
        { source: 'wait', sourcePort: 'out-0', target: 'report', targetPort: 'in-0' },
    ],
});

/** the runner's prepareScript stands in for the server's: the component's process is `process` */
const scripted =
    (process: (input: Record<string, unknown>) => unknown): PrepareScript =>
    async () =>
    async input =>
        process(input as Record<string, unknown>);

const run = (bad: boolean, process: (input: Record<string, unknown>) => unknown, report: Partial<ExecutableFlow['nodes'][number]> = {}) =>
    flowRunner(flow(report), { mode: 'execution', id: 'r', evaluate, input: [{ bad }], prepareScript: scripted(process) });

const firstError = (input: Record<string, unknown>) => (input.wait as { firstError: unknown }).firstError;

test("rethrow(firstError): the run's error is the chain, rethrower ← origin; the component's line says where it came from", async () => {
    const r = await run(true, input => rethrow(firstError(input)));
    expect(r.status).toBe('failed');
    expect(r.error).toBe('"Report page result" ← "Insert": value too long');
    const report = r.components.find(c => c.nodeId === 'report')!;
    expect(report.logs.some(l => l.level === 'error' && l.message === 'value too long (from "Insert")')).toBe(true);
});

test('throw new Error(message, { cause: firstError }) is the same as rethrow, with its own message', async () => {
    const r = await run(true, input => {
        throw new Error('the page did not load', { cause: firstError(input) });
    });
    expect(r.error).toBe('"Report page result" ← "Insert": the page did not load');
});

test('an error without a cause: only the component that threw it, as before', async () => {
    const r = await run(true, () => {
        throw new Error('plain');
    });
    expect(r.error).toBe('"Report page result": plain');
});

test('rethrow of null or undefined (the Wait had no error) does nothing: the envelope goes on', async () => {
    const r = await run(false, input => {
        rethrow(firstError(input));
        rethrow(undefined);
        return 'loaded';
    });
    expect(r.status).toBe('completed');
    expect(r.components.find(c => c.nodeId === 'end')!.inputSample).toEqual([
        {
            bad: false,
            wait: { status: 'success', envelopes: 1, errors: 0, firstError: null, last: { bad: false, ok: true } },
            result: 'loaded',
        },
    ]);
});

test('diverted again, the error keeps where it began (origin): a second rethrow names the whole way', async () => {
    const r = await run(true, input => rethrow(firstError(input)), { config: { code: 'async function process() {}', onError: 'divert' } });
    const errors = r.components.find(c => c.nodeId === 'end')!.inputSample[0]!.errors as unknown[];
    expect(errors.at(-1)).toEqual({ error: 'Error', message: 'value too long', component: 'Report page result', origin: 'Insert' });
    // the next component that throws it again: the one that diverted it, then where it began
    const again = toError(Object.assign(new Error('value too long'), { cause: errors.at(-1) }));
    expect(errorOrigins(again)).toEqual(['Report page result', 'Insert']);
    expect(errorWithOrigin('Final', again)).toBe('"Final" ← "Report page result" ← "Insert": value too long');
});

test("rethrow: an Error as it is, a text as an Error, an entry with its type; toError keeps the cause of another realm's error", () => {
    const original = new TypeError('boom');
    expect(() => rethrow(original)).toThrow(original);
    expect(() => rethrow('just text')).toThrow('just text');
    try {
        rethrow({ error: 'RequestError', message: 'timeout', component: 'HTTP' });
    } catch (e) {
        expect((e as Error).name).toBe('RequestError');
        expect(errorWithOrigin('Report', e as Error)).toBe('"Report" ← "HTTP": timeout');
    }
    // node:vm errors fail instanceof Error: read by shape, the cause kept
    const foreign = { name: 'Error', message: 'again', cause: { error: 'Error', message: 'x', component: 'Insert' } };
    expect(errorOrigins(toError(foreign))).toEqual(['Insert']);
    expect(errorOrigins(new Error('none'))).toEqual([]);
});
