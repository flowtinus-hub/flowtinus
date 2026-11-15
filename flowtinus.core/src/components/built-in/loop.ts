import { COMPONENT_TYPE } from '#components/component-types';
import { concurrently } from '#engine/concurrently';
import { TEST_RUN_MAX_ITERATIONS } from '#engine/constants';
import { toError } from '#errors/normalize-error';
import type { ComponentLogic } from '#types/component-logic.type';
import type { ComponentOutput } from '#types/component-output.type';
import type { Envelope } from '#types/envelope.type';

export type CheckTiming = 'before' | 'after';

export const DEFAULT_MAX_ITERATIONS = 100;
export const MAX_ITERATIONS = 100_000;
/** fixed, not a setting */
export const PARALLEL_LOOPS = 10;

export function loopConfig(config: Record<string, unknown>) {
    const max = Number(config.maxIterations);
    return {
        maxIterations: Number.isInteger(max) && max >= 1 ? Math.min(max, MAX_ITERATIONS) : DEFAULT_MAX_ITERATIONS,
        stopCondition: typeof config.stopCondition === 'string' ? config.stopCondition.trim() : '',
        checkTiming: (config.checkTiming === 'after' ? 'after' : 'before') as CheckTiming,
        parallel: config.parallel === true,
    };
}

const loopError = (message: string) => Object.assign(new Error(message), { name: 'LoopError' });

/*
 * The Loop (GLOSSARY, Loops): a box whose loop region (the nodes that name it in `loop`) runs again and again, one
 * iteration after another. The engine runs each iteration (ctx.runIteration, ADR 0002); this is the loop around it.
 */
export const loop: ComponentLogic = {
    type: COMPONENT_TYPE.loop,
    label: 'Loop',
    category: 'flow',
    description: `Runs its loop region (nodes with \`loop: <its id>\`) again and again; each input envelope runs a loop of its own, in arrival order (parallel: ${PARALLEL_LOOPS} at once). Each iteration starts at iteration-start with the loop state (that envelope); what reaches iteration-end goes out as it arrives. The stop condition (on the loop state and $_loopIndex, 0 first) is checked before each iteration, or from the second with checkTiming after (do-while): true ends the loop. Max iterations ends it with a warning (50 in a test run). A failed iteration ends that loop: it is the Loop's error for that envelope (On error).`,
    example: { maxIterations: 100, stopCondition: '$_loopIndex >= $pages', checkTiming: 'before' },
    inputs: 1,
    outputs: 1,
    settings: [
        {
            key: 'maxIterations',
            label: 'Max iterations',
            kind: 'number',
            required: true,
            default: DEFAULT_MAX_ITERATIONS,
            min: 1,
            max: MAX_ITERATIONS,
            description: `A safety limit: the loop ends after this many iterations, with a warning (${TEST_RUN_MAX_ITERATIONS} at most in a test run).`,
        },
        {
            key: 'stopCondition',
            label: 'Stop condition',
            kind: 'expression',
            placeholder: '$_loopIndex >= 10 || !$hasMore',
            description: 'An expression on the loop state and $_loopIndex: true ends the loop. Empty: only max iterations ends it.',
        },
        {
            key: 'checkTiming',
            label: 'Check the stop condition',
            kind: 'select',
            default: 'before',
            options: [
                { value: 'before', label: 'Before each iteration' },
                { value: 'after', label: 'After each iteration (do-while: not before the first)' },
            ],
        },
        {
            key: 'parallel',
            label: 'Parallel',
            kind: 'boolean',
            default: false,
            description: `Runs the loops of several input envelopes at the same time, up to ${PARALLEL_LOOPS} at once (the rest wait); their output goes out interleaved, as it arrives. Off: one loop after another, in arrival order.`,
        },
    ],

    validate(config) {
        const max = Number(config.maxIterations);
        if (config.maxIterations === undefined || config.maxIterations === '' || !Number.isInteger(max) || max < 1) {
            return ['has no max iterations (a whole number, 1 or more).'];
        }
        return [];
    },

    async *execute(inputs, config, ctx) {
        const { maxIterations, stopCondition, checkTiming, parallel } = loopConfig(config);
        const ceiling = ctx.run.mode === 'validation' ? Math.min(maxIterations, TEST_RUN_MAX_ITERATIONS) : maxIterations;
        const condition = { value: stopCondition, expression: true };
        let loops = 0;
        let iterations = 0;
        let capped = 0;
        /** numbered from 1 as it starts, so in arrival order */
        async function* loopOf(doc: Envelope): AsyncGenerator<ComponentOutput> {
            loops += 1;
            const envelopeNumber = loops;
            let state = doc;
            try {
                for (let index = 0; ; index += 1) {
                    const checked = stopCondition && !(checkTiming === 'after' && index === 0);
                    if (checked && ctx.fieldValue(condition, state, { $_loopIndex: index })) {
                        break;
                    }
                    if (index >= ceiling) {
                        capped += 1;
                        break;
                    }
                    iterations += 1;
                    const iteration = ctx.runIteration(state, { envelope: envelopeNumber, index });
                    try {
                        for await (const out of iteration.envelopes) {
                            yield { port: 'out-0', doc: out };
                        }
                        const { record, broke, continues, nextState } = await ctx.wait(iteration.result);
                        if (record.status === 'failed') {
                            throw loopError(`Iteration ${index} failed: ${record.error ?? 'no details'}`);
                        }
                        if (broke) {
                            break;
                        }
                        if (continues > 1) {
                            throw loopError(
                                `Iteration ${index}: ${continues} envelopes reached Continue with (one at most: it is the loop state of the next iteration).`,
                            );
                        }
                        state = nextState ?? state;
                    } finally {
                        iteration.cancel();
                    }
                }
            } catch (e) {
                yield { error: toError(e), doc };
            }
        }
        const input = inputs['in-0'] ?? [];
        if (parallel) {
            yield* concurrently(input, PARALLEL_LOOPS, loopOf);
        } else {
            for await (const doc of input) {
                yield* loopOf(doc);
            }
        }
        if (capped > 0) {
            const testRun = ceiling < maxIterations ? ' in a test run' : '';
            ctx.warn(`Max iterations (${ceiling}) reached${testRun}${loops > 1 ? ` by ${capped} of ${loops} loops` : ''}.`);
        }
        ctx.log('debug', `${loops} loop(s), ${iterations} iteration(s).`);
    },
};
