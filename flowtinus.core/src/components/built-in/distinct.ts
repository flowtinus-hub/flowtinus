import { COMPONENT_TYPE } from '#components/component-types';
import { toError } from '#errors/normalize-error';
import type { ComponentLogic } from '#types/component-logic.type';

export function distinctKeys(config: Record<string, unknown>): string[] {
    return Array.isArray(config.keys) ? config.keys.filter((k): k is string => typeof k === 'string') : [];
}

export const distinct: ComponentLogic = {
    type: COMPONENT_TYPE.distinct,
    label: 'Distinct',
    category: 'transformation',
    description:
        'Lets through (out-0) only the first envelope of each key and sends the repeated ones to the duplicates output (out-1, may stay unconnected). The key is a list of expressions; without any, the whole DATA. Values compare as JSON.',
    example: { keys: ['$email'] },
    inputs: 1,
    outputs: 2,
    outputLabels: ['unique', 'duplicates'],
    optionalOutputs: ['out-1'],
    settings: [
        {
            key: 'keys',
            label: 'Keys',
            kind: 'list',
            itemLabel: 'key',
            flat: true,
            item: [{ key: 'key', label: 'Key', kind: 'expression', required: true, placeholder: '$email' }],
        },
    ],

    validate(config) {
        const issues: string[] = [];
        distinctKeys(config).forEach((k, i) => {
            if (!k.trim()) {
                issues.push(`key ${i + 1} is empty.`);
            }
        });
        return issues;
    },

    async *execute(inputs, config, ctx) {
        const keys = distinctKeys(config);
        const seen = new Set<string>();
        let duplicates = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            let key: string;
            try {
                key = JSON.stringify(keys.length ? keys.map(k => ctx.fieldValue({ value: k, expression: true }, doc) ?? null) : doc.DATA);
            } catch (e) {
                yield { error: toError(e), doc };
                continue;
            }
            if (seen.has(key)) {
                duplicates += 1;
                yield { port: 'out-1', doc };
                continue;
            }
            seen.add(key);
            ctx.holding(seen.size);
            yield { port: 'out-0', doc };
        }
        ctx.log('debug', `${seen.size} distinct envelope(s) and ${duplicates} duplicate(s).`);
    },
};
