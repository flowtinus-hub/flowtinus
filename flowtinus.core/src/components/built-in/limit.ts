import { COMPONENT_TYPE } from '#components/component-types';
import type { ComponentLogic } from '#types/component-logic.type';
import type { Envelope } from '#types/envelope.type';

export type LimitMode = 'top' | 'bottom';

export const MAX_LIMIT = 1_000_000;

export function limitConfig(config: Record<string, unknown>) {
    const n = Math.round(Number(config.count ?? 10));
    return {
        mode: (config.mode === 'bottom' ? 'bottom' : 'top') as LimitMode,
        count: Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(1, n)) : 10,
    };
}

export const limit: ComponentLogic = {
    type: COMPONENT_TYPE.limit,
    label: 'Limit',
    category: 'transformation',
    description:
        'Lets only N envelopes through, unchanged: the first N as they arrive (top) or the last N when the input ends (bottom). Handy to test a flow on a sample. Last 1 is a barrier: one envelope goes on only after every component before it finished with every envelope (e.g. to advance a checkpoint or release a lock once); nothing goes on when no envelope arrives.',
    example: { mode: 'top', count: 10 },
    inputs: 1,
    outputs: 1,
    settings: [
        {
            key: 'mode',
            label: 'Keep',
            kind: 'select',
            default: 'top',
            options: [
                { value: 'top', label: 'First' },
                { value: 'bottom', label: 'Last' },
            ],
        },
        { key: 'count', label: 'Envelopes', kind: 'number', default: 10, min: 1, max: MAX_LIMIT },
    ],

    validate() {
        return [];
    },

    async *execute(inputs, config, ctx) {
        const { mode, count } = limitConfig(config);
        let received = 0;
        if (mode === 'top') {
            for await (const doc of inputs['in-0'] ?? []) {
                received += 1;
                if (received <= count) {
                    yield { port: 'out-0', doc };
                }
            }
        } else {
            // ring buffer with the last N: the oldest one is overwritten
            const last: Envelope[] = [];
            for await (const doc of inputs['in-0'] ?? []) {
                last[received % count] = doc;
                received += 1;
                ctx.holding(Math.min(received, count), doc);
            }
            const kept = Math.min(received, count);
            for (let i = 0; i < kept; i++) {
                ctx.holding(kept - i - 1);
                yield { port: 'out-0', doc: last[(received - kept + i) % count] };
            }
        }
        const passed = Math.min(received, count);
        ctx.log('debug', `${passed} of ${received} envelope(s) passed (${mode} ${count}).`);
    },
};
