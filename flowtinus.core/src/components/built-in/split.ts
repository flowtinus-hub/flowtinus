import { COMPONENT_TYPE } from '#components/component-types';
import { toError } from '#errors/normalize-error';
import type { ComponentLogic } from '#types/component-logic.type';
import type { EnvelopeData } from '#types/envelope-data.type';

export function splitList(config: Record<string, unknown>): string {
    return typeof config.list === 'string' ? config.list : '$items';
}

function isObject(value: unknown): value is EnvelopeData {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const split: ComponentLogic = {
    type: COMPONENT_TYPE.split,
    label: 'Split',
    category: 'transformation',
    description:
        'The opposite of Aggregate: evaluates an expression that gives a list (default `$items`) and yields one envelope per item, the item as the whole DATA. Every item must be an object; an empty list yields nothing.',
    example: { list: '$items' },
    inputs: 1,
    outputs: 1,
    settings: [{ key: 'list', label: 'List', kind: 'expression', required: true, default: '$items', placeholder: '$items' }],

    validate(config) {
        return splitList(config).trim() ? [] : ['has no list.'];
    },

    async *execute(inputs, config, ctx) {
        const list = splitList(config);
        let received = 0;
        let items = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            received += 1;
            let value: unknown;
            try {
                value = ctx.fieldValue({ value: list, expression: true }, doc);
                if (!Array.isArray(value)) {
                    throw new TypeError(`${list} is not a list (${value === null ? 'null' : typeof value}).`);
                }
                const index = value.findIndex(item => !isObject(item));
                if (index >= 0) {
                    throw new TypeError(`${list}[${index}] is not an object.`);
                }
            } catch (e) {
                yield { error: toError(e), doc };
                continue;
            }
            for (const item of value as EnvelopeData[]) {
                items += 1;
                yield { port: 'out-0', doc: { FLOW_CURRENT_RUN: doc.FLOW_CURRENT_RUN, PARAMETERS: doc.PARAMETERS, DATA: item } };
            }
        }
        ctx.log('debug', `${received} envelope(s) split into ${items}.`);
    },
};
