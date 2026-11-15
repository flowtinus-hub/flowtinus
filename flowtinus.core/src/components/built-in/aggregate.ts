import { COMPONENT_TYPE } from '#components/component-types';
import { nameIssue } from '#validation/key-name';
import type { ComponentLogic } from '#types/component-logic.type';
import type { Envelope } from '#types/envelope.type';

export const MAX_BATCH_SIZE = 10_000;
export const ALL_BATCH_WARNING = 100_000;
export const AGGREGATE_MODES = ['size', 'all'] as const;
export type AggregateMode = (typeof AGGREGATE_MODES)[number];

export function aggregateConfig(config: Record<string, unknown>) {
    const n = Math.round(Number(config.size ?? 500));
    return {
        mode: (AGGREGATE_MODES.includes(config.mode as AggregateMode) ? config.mode : 'size') as AggregateMode,
        size: Number.isFinite(n) ? Math.min(MAX_BATCH_SIZE, Math.max(1, n)) : 500,
        field: typeof config.field === 'string' ? config.field : 'items',
        whenEmpty: config.whenEmpty === true,
    };
}

export const aggregate: ComponentLogic = {
    type: COMPONENT_TYPE.aggregate,
    label: 'Aggregate',
    category: 'transformation',
    description:
        'Groups the envelopes into batches of N, or All of them in one batch when the input ends, and yields one envelope per batch with the list of DATA in a field (default `items`): {items: [DATA, ...]}. The last batch may be smaller. With "Empty list when nothing arrives", an input that ends empty yields {items: []}. Use it before a component that writes many records at once, or one that needs them all (a CSV of a whole query).',
    example: { mode: 'size', size: 500, field: 'items' },
    inputs: 1,
    outputs: 1,
    settings: [
        {
            key: 'mode',
            label: 'Batch size',
            kind: 'select',
            default: 'size',
            options: [
                { value: 'size', label: 'Every N envelopes' },
                { value: 'all', label: 'All (one batch when the input ends)' },
            ],
        },
        {
            key: 'size',
            label: 'Envelopes per batch',
            kind: 'number',
            default: 500,
            min: 1,
            max: MAX_BATCH_SIZE,
            when: { key: 'mode', values: ['size'] },
        },
        { key: 'field', label: 'Field', kind: 'text', required: true, default: 'items', placeholder: 'items' },
        { key: 'whenEmpty', label: 'Empty list when nothing arrives', kind: 'boolean', default: false },
    ],

    validate(config) {
        const issue = nameIssue(aggregateConfig(config).field);
        return issue ? [`field ${issue}.`] : [];
    },

    async *execute(inputs, config, ctx) {
        const { mode, size, field, whenEmpty } = aggregateConfig(config);
        const limit = mode === 'all' ? Infinity : size;
        let batch: Envelope[] = [];
        let batches = 0;
        let received = 0;
        let warned = false;
        const flush = () => {
            batches += 1;
            const doc: Envelope = {
                FLOW_CURRENT_RUN: batch[0].FLOW_CURRENT_RUN,
                PARAMETERS: batch[0].PARAMETERS,
                DATA: { [field]: batch.map(d => d.DATA) },
            };
            batch = [];
            ctx.holding(0);
            return { port: 'out-0', doc };
        };
        for await (const doc of inputs['in-0'] ?? []) {
            received += 1;
            batch.push(doc);
            ctx.holding(batch.length, doc);
            if (mode === 'all' && !warned && batch.length > ALL_BATCH_WARNING) {
                warned = true;
                ctx.log(
                    'warning',
                    `More than ${ALL_BATCH_WARNING} envelopes held in memory for one batch (Batch size All); for a larger volume, batches of N and an incremental write.`,
                );
            }
            if (batch.length >= limit) {
                yield flush();
            }
        }
        if (batch.length) {
            yield flush();
        } else if (received === 0 && whenEmpty) {
            batches += 1;
            yield {
                port: 'out-0',
                doc: { FLOW_CURRENT_RUN: ctx.run, PARAMETERS: ctx.parameters ?? {}, DATA: { [field]: [] } },
            };
        }
        ctx.log(
            'debug',
            mode === 'all'
                ? `${received} envelope(s) in ${batches} batch(es) (all).`
                : `${received} envelope(s) in ${batches} batch(es) of up to ${size}.`,
        );
    },
};
