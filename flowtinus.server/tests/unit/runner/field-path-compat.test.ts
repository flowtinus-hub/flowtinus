import { describe, expect, test } from 'bun:test';
import { envelopeVariables, NOT_A_PATH, readPath, type Envelope } from '@flowtinus/core';
import { createEvaluate } from '#shared/runner/evaluate';

/*
 * The fast read of an expression that only reads a value (@flowtinus/core field-path.ts) against the run's evaluator:
 * each expression it reads must give the very value the evaluator gives; what it does not read (NOT_A_PATH) goes to
 * the evaluator, so its errors stay the evaluator's.
 */

const evaluate = createEvaluate();
const secrets = { TOKEN: 's3cr3t' };
const variables = { REGION: 'br' };
const envelope = (data: Record<string, unknown>): Envelope => ({
    FLOW_CURRENT_RUN: { id: 'run-1', mode: 'execution', workspace: 'w', project: 'p', flow: 'f', startedAt: '2026-01-01T00:00:00.000Z' },
    PARAMETERS: { size: '10', name: 'x' },
    DATA: data,
});
const viaEvaluator = (expression: string, doc: Envelope) => evaluate(expression, envelopeVariables(doc, secrets, variables));

const data = {
    email: 'a@b.c',
    n: 0,
    flag: false,
    nothing: null,
    list: [1, 2, 3],
    text: 'abc',
    customer: { address: { city: 'Recife' }, tags: ['x'] },
    // a field with a reserved name wins over the variable (as envelopeVariables does it)
    PARAMETERS: { shadowed: true },
};

const READ = [
    '$email',
    ' $email ',
    '$n',
    '$flag',
    '$nothing',
    '$list',
    '$list.length',
    '$text.length',
    '$customer',
    '$customer.address.city',
    '$customer.tags.length',
    '$customer.address.zip',
    '$missing',
    '$DATA',
    '$DATA.email',
    '$PARAMETERS',
    '$PARAMETERS.shadowed',
    '$FLOW_CURRENT_RUN.id',
    '$SECRETS.TOKEN',
    '$VARIABLES.REGION',
    '$VARIABLES.NONE',
];

const LEFT_TO_THE_EVALUATOR = [
    '$missing.x',
    '$nothing.x',
    '$customer.address.zip.code',
    '$n.toFixed',
    '$customer.constructor',
    '$customer.__proto__',
    '$customer.hasOwnProperty',
    '$list[0]',
    '$email + ""',
    '$email.toUpperCase()',
    '$a?.b',
    '$café',
    'email',
];

describe('an expression that only reads a value: read straight, the value the evaluator gives', () => {
    for (const expression of READ) {
        test(expression, () => {
            const doc = envelope(structuredClone(data));
            const direct = readPath(expression, doc, secrets, variables);
            expect(direct).not.toBe(NOT_A_PATH);
            expect(direct).toEqual(viaEvaluator(expression, doc));
        });
    }

    test('the same object, not a copy (as the evaluator hands it)', () => {
        const doc = envelope(structuredClone(data));
        expect(readPath('$customer.address', doc, secrets, variables)).toBe(viaEvaluator('$customer.address', doc));
    });

    test('anything else is left to the evaluator (its value, or its error naming the missing field)', () => {
        const doc = envelope(structuredClone(data));
        for (const expression of LEFT_TO_THE_EVALUATOR) {
            expect(readPath(expression, doc, secrets, variables)).toBe(NOT_A_PATH);
        }
        expect(() => viaEvaluator('$missing.x', doc)).toThrow('not in this envelope: $missing');
    });
});
