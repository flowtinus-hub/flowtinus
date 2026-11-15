import { describe, expect, test } from 'bun:test';
import { readAppSettings } from '#shared/config/app-settings';
import { openDatabase } from '#shared/database/database';
import { createLogger, type ServerLogLevel } from '#shared/logging/logger';
import { createApp } from '../../../api/app';

const capture = (format: 'pretty' | 'json', level: ServerLogLevel = 'info') => {
    const lines: { line: string; level: ServerLogLevel }[] = [];
    const logger = createLogger({ service: 'api', level, format, write: (line, at) => lines.push({ line, level: at }) });
    return { logger, lines };
};

describe('the server log', () => {
    test('pretty: the message, then key=value (quoted when needed); warnings and errors tagged; undefined left out', () => {
        const { logger, lines } = capture('pretty');
        logger.info('Run "Orders" completed in 3 ms', { runId: 'r1', flow: 'My flow', durationMs: 3, projectId: undefined });
        logger.warn('Heartbeat failed.', { tries: 2 });
        expect(lines.map(l => l.line)).toEqual([
            'Run "Orders" completed in 3 ms  runId=r1 flow="My flow" durationMs=3',
            'WARN Heartbeat failed.  tries=2',
        ]);
    });

    test('json: one object per line with time, level, service, msg and the fields (snake_case); an Error as its message and stack', () => {
        const { logger, lines } = capture('json');
        logger.child({ supervisorId: 's1' }).error('Could not claim a run.', { error: new Error('connection lost') });
        const event = JSON.parse(lines[0]!.line);
        expect(event).toMatchObject({
            level: 'error',
            service: 'api',
            msg: 'Could not claim a run.',
            supervisor_id: 's1',
            error: 'connection lost',
        });
        expect(event.stack).toContain('connection lost');
        expect(Date.parse(event.time)).not.toBeNaN();
    });

    test('below the level, nothing', () => {
        const { logger, lines } = capture('pretty', 'warn');
        logger.debug('a');
        logger.info('b');
        logger.warn('c');
        expect(lines.map(l => l.line)).toEqual(['WARN c']);
    });

    test('LOG_LEVEL and LOG_FORMAT: info and pretty by default, any case, refused when unknown', () => {
        expect(readAppSettings({})).toMatchObject({ logLevel: 'info', logFormat: 'pretty' });
        expect(readAppSettings({ LOG_LEVEL: 'DEBUG', LOG_FORMAT: 'Json' })).toMatchObject({ logLevel: 'debug', logFormat: 'json' });
        expect(() => readAppSettings({ LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL must be one of debug, info, warn, error');
    });

    test('the api: one event per request, its route and status; reads debug, refusals warnings, failures errors with the stack', async () => {
        const db = await openDatabase('memory://');
        try {
            const { logger, lines } = capture('json', 'debug');
            const app = createApp(db, 'DEV', undefined, logger);
            app.get('/boom', () => {
                throw new Error('kaput');
            });
            await app.request('/health');
            await app.request('/projects');
            await app.request('/boom', { headers: { 'x-user-id': 'u' } });
            const events = lines.map(l => JSON.parse(l.line));
            expect(events.find(e => e.path === '/health')).toMatchObject({
                level: 'debug',
                method: 'GET',
                status_code: 200,
                route: '/health',
            });
            expect(events.find(e => e.path === '/projects')).toMatchObject({ level: 'warn', status_code: 401 });
            expect(events.find(e => e.msg === 'Unexpected error on GET /boom')).toMatchObject({ level: 'error', error: 'kaput' });
            expect(events.find(e => e.msg === 'GET /boom 500')).toMatchObject({ level: 'error', status_code: 500, user_id: 'u' });
        } finally {
            await db.close();
        }
    });
});

test("the process's instance (a supervisor's container name) goes in every JSON line; none when not given", () => {
    const lines: string[] = [];
    createLogger({ service: 'supervisor', instance: 'supervisor-2', format: 'json', write: line => lines.push(line) }).info('hi');
    createLogger({ service: 'api', format: 'json', write: line => lines.push(line) }).info('hi');
    expect(JSON.parse(lines[0]!)).toMatchObject({ service: 'supervisor', instance: 'supervisor-2', msg: 'hi' });
    expect('instance' in JSON.parse(lines[1]!)).toBe(false);
});

test('an event told later keeps when it happened (`at`), not when it was written', () => {
    const lines: string[] = [];
    const logger = createLogger({ service: 'supervisor', format: 'json', write: line => lines.push(line) });
    logger.info('called run ended', { at: '2026-11-07T18:58:40.100Z', runId: 'r1' });
    logger.info('now');
    const [told, now] = lines.map(line => JSON.parse(line) as Record<string, unknown>);
    expect(told).toMatchObject({ time: '2026-11-07T18:58:40.100Z', run_id: 'r1' });
    expect('at' in told!).toBe(false);
    expect(now!.time).not.toBe('2026-11-07T18:58:40.100Z');
});
