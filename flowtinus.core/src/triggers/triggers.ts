import { Cron } from 'croner';

export type MisfireMode = 'relaxed' | 'strict' | 'ignorable';
export const MISFIRE_MODES: MisfireMode[] = ['relaxed', 'strict', 'ignorable'];
export const DEFAULT_MISFIRE: MisfireMode = 'relaxed';

export type WebhookResponse = 'async' | 'wait';
export const WEBHOOK_RESPONSES: WebhookResponse[] = ['async', 'wait'];
export const DEFAULT_WEBHOOK_RESPONSE: WebhookResponse = 'async';

const cronJob = (cron: string, timezone: string) => new Cron(cron.trim(), { timezone, paused: true });

export function cronError(cron: string, timezone: string): string | undefined {
    const count = cron.trim().split(/\s+/).filter(Boolean).length;
    if (count !== 5 && count !== 6) {
        return 'Use 5 fields (minute hour day month weekday) or 6 (second first).';
    }

    try {
        if (cronJob(cron, timezone).nextRun() === null) {
            return 'It never runs (no such date).';
        }
    } catch (e) {
        const message = (e as Error).message;
        return /timezone/i.test(message) ? `Unknown time zone: ${timezone}.` : message.replace(/^CronPattern: /, '');
    }

    return undefined;
}

export function nextTime(cron: string, timezone: string, after: Date): Date | null {
    return cronJob(cron, timezone).nextRun(after);
}

export function nextTimes(cron: string, timezone: string, count = 5, from = new Date()): Date[] {
    return cronError(cron, timezone) ? [] : cronJob(cron, timezone).nextRuns(count, from);
}

export function dueTimes(cron: string, timezone: string, first: Date, until: Date, limit: number): Date[] {
    const times = [first];
    while (times.length < limit) {
        const next = nextTime(cron, timezone, times[times.length - 1]!);
        if (!next || next > until) {
            break;
        }

        times.push(next);
    }

    return times;
}
