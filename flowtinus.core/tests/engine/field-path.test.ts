import { expect, test } from 'bun:test';
import { flowRunner, NOT_A_PATH, readPath, type ExecutableFlow } from '../../src/index';
import { evaluate } from '../helpers';

/** Start → Mapper (the fields given) → End */
const mapper = (fields: { target: string; value: string }[]): ExecutableFlow => ({
    project: 'Test',
    flow: 'Paths',
    parameters: [{ name: 'since', type: 'text', default: '2026' }],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
        { id: 'm', type: 'mapper', label: 'Mapper', config: { fields: fields.map(f => ({ ...f, expression: true })) } },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'm', targetPort: 'in-0' },
        { source: 'm', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

test('an expression that only reads a value does not go through the evaluator; any other one does, as before', async () => {
    const asked: string[] = [];
    const counting = (expression: string, variables: Record<string, unknown>) => {
        asked.push(expression);
        return evaluate(expression, variables);
    };
    const record = await flowRunner(
        mapper([
            { target: 'email', value: '$customer.email' },
            { target: 'city', value: '$customer.address.city' },
            { target: 'since', value: '$PARAMETERS.since' },
            { target: 'token', value: '$SECRETS.TOKEN' },
            { target: 'none', value: '$customer.phone' },
            { target: 'upper', value: '$customer.email.toUpperCase()' },
        ]),
        {
            mode: 'execution',
            id: 'f1',
            evaluate: counting,
            secrets: { TOKEN: 't' },
            input: [{ customer: { email: 'a@b.c', address: { city: 'Recife' } } }],
        },
    );
    expect(record.status).toBe('completed');
    const out = record.components.find(c => c.nodeId === 'm')!.outputSample['out-0']![0]!;
    expect(out).toMatchObject({ email: 'a@b.c', city: 'Recife', since: '2026', token: 't', upper: 'A@B.C' });
    expect('none' in out ? out.none : undefined).toBeUndefined();
    expect(asked).toEqual(['$customer.email.toUpperCase()']);
});

test("reading into a missing field still fails with the evaluator's error", async () => {
    const record = await flowRunner(mapper([{ target: 'x', value: '$customer.address.city' }]), {
        mode: 'execution',
        id: 'f2',
        evaluate,
        input: [{ customer: {} }],
    });
    expect(record.status).toBe('failed');
    // the evaluator's own error (the engine's message names the expression)
    expect(record.error).toContain("'$customer.address.city'");
});

test('what readPath reads, and what it leaves', () => {
    const doc = { FLOW_CURRENT_RUN: { id: 'r' } as never, PARAMETERS: { p: '1' }, DATA: { a: { b: [1, 2] }, s: 'xy', DATA: 'mine' } };
    expect(readPath('$a.b.length', doc)).toBe(2);
    expect(readPath('$s.length', doc)).toBe(2);
    expect(readPath('$DATA', doc)).toBe('mine');
    expect(readPath('$PARAMETERS.p', doc)).toBe('1');
    expect(readPath('$nope', doc)).toBeUndefined();
    expect(readPath('$a.c', doc)).toBeUndefined();
    for (const left of ['$nope.x', '$a.b.map', '$a.constructor', '$a["b"]', '$a.b[0]', '$s + 1', '1', '$ação']) {
        expect(readPath(left, doc)).toBe(NOT_A_PATH);
    }
});
