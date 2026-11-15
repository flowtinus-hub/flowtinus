import { COMPONENT_TYPE } from '#components/component-types';
import { toError } from '#errors/normalize-error';
import type { ComponentLogic } from '#types/component-logic.type';

export function filterCondition(config: Record<string, unknown>): string {
    return typeof config.condition === 'string' ? config.condition : '';
}

export const filter: ComponentLogic = {
    type: COMPONENT_TYPE.filter,
    label: 'Filter',
    category: 'transformation',
    description:
        "Evaluates a condition (an expression) on each envelope and sends it, unchanged, to the true output (out-0) or the false one (out-1, may stay unconnected: dropped). JavaScript truthiness: 0, '' and null are false.",
    example: { condition: "$total > 100 && $status === 'open'" },
    inputs: 1,
    outputs: 2,
    outputLabels: ['true', 'false'],
    optionalOutputs: ['out-1'],
    settings: [{ key: 'condition', label: 'Condition', kind: 'expression', required: true, placeholder: '$price > 10' }],

    validate(config) {
        return filterCondition(config).trim() ? [] : ['has no condition.'];
    },

    async *execute(inputs, config, ctx) {
        const condition = filterCondition(config);
        let trues = 0;
        let falses = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            try {
                if (ctx.fieldValue({ value: condition, expression: true }, doc)) {
                    trues += 1;
                    yield { port: 'out-0', doc };
                } else {
                    falses += 1;
                    yield { port: 'out-1', doc };
                }
            } catch (e) {
                yield { error: toError(e), doc };
            }
        }
        ctx.log('debug', `${trues} envelope(s) to true and ${falses} to false.`);
    },
};
