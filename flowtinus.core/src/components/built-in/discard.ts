import { COMPONENT_TYPE } from '#components/component-types';
import type { ComponentLogic } from '#types/component-logic.type';

export const discard: ComponentLogic = {
    type: COMPONENT_TYPE.discard,
    label: 'Discard',
    category: 'flow',
    description: 'The end of a path that leads nowhere on purpose: drops every envelope that reaches it (no output) and logs how many.',
    example: {},
    inputs: 1,
    outputs: 0,
    settings: [],

    validate() {
        return [];
    },

    async *execute(inputs, _config, ctx) {
        let dropped = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            void doc;
            dropped += 1;
        }
        ctx.log('debug', `${dropped} envelope(s) discarded.`);
    },
};
