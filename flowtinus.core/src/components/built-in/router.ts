import { COMPONENT_TYPE } from '#components/component-types';
import { toError } from '#errors/normalize-error';
import type { ComponentLogic } from '#types/component-logic.type';

export type RouterCase = { label: string; condition: string };

export function routerCases(config: Record<string, unknown>): RouterCase[] {
    return Array.isArray(config.cases) ? (config.cases as RouterCase[]) : [];
}

export function routerElsePort(config: Record<string, unknown>) {
    return `out-${routerCases(config).length}`;
}

export const router: ComponentLogic = {
    type: COMPONENT_TYPE.router,
    label: 'Router',
    category: 'transformation',
    description:
        'Sends each envelope, unchanged, to the output of the first case whose condition is true (one output per case, in order), or to the last output, else (may stay unconnected: dropped).',
    example: {
        cases: [
            { label: 'big', condition: '$total > 1000' },
            { label: 'medium', condition: '$total > 100' },
        ],
    },
    inputs: 1,
    // one per case + the else; the count comes from the configuration
    outputs: 1,
    outputsFromConfig: config => [...routerCases(config).map((c, i) => ({ label: c.label?.trim() || `case ${i + 1}` })), { label: 'else' }],
    optionalOutputs: config => [routerElsePort(config)],
    settings: [
        {
            key: 'cases',
            label: 'Cases',
            kind: 'list',
            itemLabel: 'case',
            required: true,
            item: [
                { key: 'label', label: 'Name', kind: 'text', placeholder: 'big' },
                { key: 'condition', label: 'Condition', kind: 'expression', required: true, placeholder: '$total > 1000' },
            ],
        },
    ],

    validate(config) {
        const cases = routerCases(config);
        if (cases.length === 0) {
            return ['has no cases.'];
        }
        const issues: string[] = [];
        cases.forEach((c, i) => {
            if (!c.condition?.trim()) {
                issues.push(`case ${i + 1} has no condition.`);
            }
        });
        return issues;
    },

    async *execute(inputs, config, ctx) {
        const cases = routerCases(config);
        const perCase = cases.map(() => 0);
        let inElse = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            try {
                const i = cases.findIndex(c => ctx.fieldValue({ value: c.condition, expression: true }, doc));
                if (i >= 0) {
                    perCase[i] += 1;
                } else {
                    inElse += 1;
                }
                yield { port: `out-${i >= 0 ? i : cases.length}`, doc };
            } catch (e) {
                yield { error: toError(e), doc };
            }
        }
        ctx.log('debug', [...cases.map((c, i) => `${c.label || `case ${i + 1}`}: ${perCase[i]}`), `else: ${inElse}`].join(', ') + '.');
    },
};
