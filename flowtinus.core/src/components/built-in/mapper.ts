import { COMPONENT_TYPE } from '#components/component-types';
import { toError } from '#errors/normalize-error';
import { mergeFields } from '#envelope/envelope-data';
import { nameIssue } from '#validation/key-name';
import type { ExpressionField } from '#types/expression-field.type';
import type { ComponentLogic } from '#types/component-logic.type';
import type { EnvelopeData } from '#types/envelope-data.type';

export type MapperField = ExpressionField & { target: string };

export function mapperFields(config: Record<string, unknown>): MapperField[] {
    return Array.isArray(config.fields) ? (config.fields as MapperField[]) : [];
}

export const mapper: ComponentLogic = {
    type: COMPONENT_TYPE.mapper,
    label: 'Mapper',
    category: 'transformation',
    description:
        "Writes fields into the envelope's DATA: each field is a value (fixed or an expression on the incoming envelope) and the key it goes to; a key that exists is replaced. Sources are evaluated on the incoming envelope. Override: the output DATA has only the mapped fields.",
    example: {
        fields: [
            { target: 'total', value: '$price * $quantity', expression: true },
            { target: 'currency', value: 'USD', expression: false },
        ],
    },
    inputs: 1,
    outputs: 1,
    usesOverride: true,
    settings: [
        {
            key: 'fields',
            label: 'Fields',
            kind: 'list',
            itemLabel: 'field',
            required: true,
            arrow: true,
            item: [
                {
                    key: 'value',
                    label: 'Source (value)',
                    kind: 'value',
                    spread: true,
                    default: { value: '', expression: true },
                    placeholder: '$price * $quantity',
                },
                { key: 'target', label: 'Key in the envelope', kind: 'text', required: true, placeholder: 'total' },
            ],
        },
    ],

    validate(config) {
        const fields = mapperFields(config);
        if (fields.length === 0) {
            return ['has no fields.'];
        }
        const issues: string[] = [];
        const seen = new Set<string>();
        fields.forEach((f, i) => {
            const issue = nameIssue(f.target);
            if (issue) {
                issues.push(`field ${i + 1} ${issue}.`);
            } else if (seen.has(f.target)) {
                issues.push(`has the field "${f.target}" more than once.`);
            }
            seen.add(f.target);
            if (f.expression && !f.value.trim()) {
                issues.push(`field "${f.target || i + 1}" is an expression, but empty.`);
            }
        });
        return issues;
    },

    async *execute(inputs, config, ctx) {
        const fields = mapperFields(config);
        let mapped = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            try {
                const output: EnvelopeData = {};
                for (const field of fields) {
                    output[field.target] = ctx.fieldValue(field, doc);
                }
                mapped += 1;
                yield { port: 'out-0', doc: mergeFields(doc, output, ctx.node.override) };
            } catch (e) {
                yield { error: toError(e), doc };
            }
        }
        ctx.log('debug', `${mapped} envelope(s) mapped: ${fields.map(f => f.target).join(', ')}.`);
    },
};
