import { COMPONENT_TYPE } from '#components/component-types';
import { toError } from '#errors/normalize-error';
import type { ComponentLogic } from '#types/component-logic.type';
import type { LogLevel } from '#types/log-level.type';

export type LogComponentLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: LogComponentLevel[] = ['debug', 'info', 'warn', 'error'];

export const MAX_LOG_LINES = 500;

export function logConfig(config: Record<string, unknown>) {
    return {
        level: (LOG_LEVELS.includes(config.level as LogComponentLevel) ? config.level : 'info') as LogComponentLevel,
        message: typeof config.message === 'string' ? config.message : '',
    };
}

const RUN_LEVEL: Record<LogComponentLevel, LogLevel> = { debug: 'debug', info: 'info', warn: 'warning', error: 'error' };

function text(value: unknown) {
    if (typeof value === 'string') {
        return value;
    }
    if (value === undefined) {
        return 'undefined';
    }
    try {
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
    } catch {
        return String(value);
    }
}

export const log: ComponentLogic = {
    type: COMPONENT_TYPE.log,
    label: 'Log',
    category: 'flow',
    description:
        "Evaluates a message (an expression on the envelope) and records it in the run's log of the component; the envelope goes on unchanged. Debug lines only show in the editor's test runs.",
    example: { level: 'info', message: '`order ${$id}: ${$total}`' },
    inputs: 1,
    outputs: 1,
    settings: [
        {
            key: 'level',
            label: 'Level',
            kind: 'select',
            default: 'info',
            options: LOG_LEVELS.map(level => ({ value: level, label: level.charAt(0).toUpperCase() + level.slice(1) })),
        },
        { key: 'message', label: 'Message', kind: 'expression', required: true, placeholder: '`order ${$id}`' },
    ],

    validate(config) {
        return logConfig(config).message.trim() ? [] : ['has no message.'];
    },

    async *execute(inputs, config, ctx) {
        const { level, message } = logConfig(config);
        // debug is a test-run aid: a real run does not record it
        const silent = level === 'debug' && ctx.run.mode === 'execution';
        let lines = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            if (!silent) {
                try {
                    const line = text(ctx.fieldValue({ value: message, expression: true }, doc));
                    lines += 1;
                    if (lines <= MAX_LOG_LINES) {
                        ctx.log(RUN_LEVEL[level], line);
                    }
                } catch (e) {
                    yield { error: toError(e), doc };
                    continue;
                }
            }
            yield { port: 'out-0', doc };
        }
        if (lines > MAX_LOG_LINES) {
            ctx.log('info', `${lines - MAX_LOG_LINES} more line(s) not shown here (${lines} in all).`);
        }
    },
};
