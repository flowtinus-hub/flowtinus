import { COMPONENT_TYPE } from '#components/component-types';
import { withKey } from '#envelope/envelope-data';
import type { ComponentLogic } from '#types/component-logic.type';
import type { Envelope } from '#types/envelope.type';

export type WaitStatus = 'success' | 'failure' | 'empty';

export type WaitSummary = {
    status: WaitStatus;
    envelopes: number;
    errors: number;
    /** `origin`: the component where the error began, when `component` threw it again (engine/error-origin.ts) */
    firstError: { error: string; message: string; component: string; origin?: string } | null;
    last: Record<string, unknown> | null;
};

function errorsOf(doc: Envelope): WaitSummary['firstError'][] {
    const errors = doc.DATA?.errors;
    return Array.isArray(errors) && errors.length > 0 ? (errors as WaitSummary['firstError'][]) : [];
}

export const wait: ComponentLogic = {
    type: COMPONENT_TYPE.wait,
    label: 'Wait',
    category: 'flow',
    description:
        'Holds the envelopes of `hold` until `watch` ends (everything before it finished), then lets each go on with {status: success | failure | empty, envelopes, errors, firstError, last} in its output key (default `wait`). Connect the output and the error port of what is watched to `watch`. `envelopes` counts only the watched ones without errors, `errors` those with DATA.errors: watched = envelopes + errors. Always answers, even when nothing was watched (empty).',
    example: {},
    inputs: 2,
    inputLabels: ['hold', 'watch'],
    outputs: 1,
    usesOverride: true,
    defaultOutputKey: 'wait',
    settings: [],

    validate() {
        return [];
    },

    async *execute(inputs, _config, ctx) {
        // holds the first input while the watched one runs (both may come from the same component)
        const held: Envelope[] = [];
        const hold = (async () => {
            for await (const doc of inputs['in-0'] ?? []) {
                held.push(doc);
                ctx.holding(held.length, doc);
            }
        })();

        const summary: WaitSummary = { status: 'empty', envelopes: 0, errors: 0, firstError: null, last: null };
        for await (const doc of inputs['in-1'] ?? []) {
            const errors = errorsOf(doc);
            if (errors.length > 0) {
                summary.errors += 1;
                summary.firstError ??= errors[0] ?? null;
            } else {
                summary.envelopes += 1;
                summary.last = doc.DATA;
            }
        }
        summary.status = summary.errors > 0 ? 'failure' : summary.envelopes > 0 ? 'success' : 'empty';
        ctx.log('debug', `Watched input ended: ${summary.status} (${summary.envelopes} envelope(s), ${summary.errors} error(s)).`);

        await ctx.wait(hold);
        ctx.holding(0);
        for (const doc of held) {
            const output: Envelope = ctx.node.override
                ? { FLOW_CURRENT_RUN: doc.FLOW_CURRENT_RUN, PARAMETERS: doc.PARAMETERS, DATA: { ...summary } }
                : withKey(doc, ctx.node.outputKey || 'wait', { ...summary });
            yield { port: 'out-0', doc: output };
        }
        ctx.log('debug', `${held.length} held envelope(s) released.`);
    },
};
