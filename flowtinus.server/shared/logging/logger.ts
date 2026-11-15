export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type ServerLogLevel = (typeof LOG_LEVELS)[number];
export const LOG_FORMATS = ['pretty', 'json'] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];
export type LogFields = Record<string, unknown>;
export type Logger = {
    debug: (msg: string, fields?: LogFields) => void;
    info: (msg: string, fields?: LogFields) => void;
    warn: (msg: string, fields?: LogFields) => void;
    error: (msg: string, fields?: LogFields) => void;
    child: (fields: LogFields) => Logger;
};
export type LoggerOptions = {
    service: string;
    /** which process of the service it is (a supervisor's or the api's container name): in every JSON line, so the logs of
     * several supervisors are told apart (the otel-collector makes it service.instance.id) */
    instance?: string;
    level?: ServerLogLevel;
    format?: LogFormat;
    write?: (line: string, level: ServerLogLevel) => void;
};
const RANK: Record<ServerLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const TAG: Partial<Record<ServerLogLevel, string>> = { warn: 'WARN ', error: 'ERROR ' };
const writeOut = (line: string, level: ServerLogLevel) =>
    (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);

function plain(fields: LogFields): { values: LogFields; stack?: string } {
    const values: LogFields = {};
    let stack: string | undefined;
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
            continue;
        }

        if (value instanceof Error) {
            values[key] = value.message;
            stack ??= value.stack;
        } else {
            values[key] = value;
        }
    }

    return { values, stack };
}

function pretty(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text === '' || /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

const snake = (key: string) => key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const snakeKeys = (values: LogFields) => Object.fromEntries(Object.entries(values).map(([key, value]) => [snake(key), value]));

export function createLogger(options: LoggerOptions, bound: LogFields = {}): Logger {
    const { service, instance, level = 'info', format = 'pretty', write = writeOut } = options;
    const emit = (at: ServerLogLevel, msg: string, fields: LogFields = {}) => {
        if (RANK[at] < RANK[level]) {
            return;
        }

        // `at`: when it happened, for an event told later (a call that ran inside a run is told when that run ends)
        const { at: when, ...rest } = { ...bound, ...fields };
        const time = when instanceof Date || typeof when === 'string' ? new Date(when) : new Date();
        const { values, stack } = plain(rest);
        if (format === 'json') {
            write(
                JSON.stringify({
                    time: Number.isNaN(time.getTime()) ? new Date().toISOString() : time.toISOString(),
                    level: at,
                    service,
                    ...(instance ? { instance } : {}),
                    msg,
                    ...snakeKeys(values),
                    ...(stack ? { stack } : {}),
                }),
                at,
            );
            return;
        }

        const pairs = Object.entries(values).map(([key, value]) => `${key}=${pretty(value)}`);
        write(`${TAG[at] ?? ''}${msg}${pairs.length > 0 ? `  ${pairs.join(' ')}` : ''}${stack && at === 'error' ? `\n${stack}` : ''}`, at);
    };

    return {
        debug: (msg, fields) => emit('debug', msg, fields),
        info: (msg, fields) => emit('info', msg, fields),
        warn: (msg, fields) => emit('warn', msg, fields),
        error: (msg, fields) => emit('error', msg, fields),
        child: fields => createLogger(options, { ...bound, ...fields }),
    };
}

export const silentLogger = (): Logger =>
    createLogger({
        service: 'silent',
        write: () => {},
    });
