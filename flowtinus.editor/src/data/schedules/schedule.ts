import { type MisfireMode } from '@flowtinus/core';
import cronstrue from 'cronstrue';

/*
 * A flow's schedules: when its deployed version runs by itself. A cron expression of 5 fields (minute hour day month
 * weekday) or 6 (with the second first: `30 * * * * *` runs at second 30 of every minute), in a time zone. Only a
 * deployed flow runs on a schedule. The server computes the times with the same functions (the core's), so the editor shows
 * what will happen (schedules-api.ts loads and changes them).
 */

export const MISFIRE_OPTIONS: { mode: MisfireMode; label: string }[] = [
    { mode: 'relaxed', label: 'Run once' },
    { mode: 'strict', label: 'Run each one missed' },
    { mode: 'ignorable', label: 'Skip them' },
];

/** how the last time it was due went: a run, or skipped because its previous run was still going */
export type LastFire = {
    at: Date;
    runId: string;
    status: 'queued' | 'running' | 'completed' | 'with-warnings' | 'with-errors' | 'failed' | 'cancelled' | 'skipped';
};

export type Schedule = {
    id: string;
    flowId: string;
    cron: string;
    /** IANA name, e.g. America/Sao_Paulo */
    timezone: string;
    enabled: boolean;
    arrivedDisabled: boolean;
    misfire: MisfireMode;
    /** the Start's parameters for its runs (the others take their default) */
    parameters: Record<string, string>;
    /** the flow's input for its runs (a flow whose Start accepts one); none: the Start's default input */
    input?: unknown;
    overrides?: ScheduleOverrides;
    effective?: Pick<Schedule, 'cron' | 'timezone' | 'parameters' | 'input'>;
    /** null while disabled */
    nextFireAt: Date | null;
    last: LastFire | null;
    /** why the last time it was due queued no run (the flow not deployed...) */
    lastError?: string | null;
    createdAt: Date;
    updatedBy: string;
    updatedByName?: string;
};

export type ScheduleOverrides = { cron?: string; timezone?: string; input?: unknown; parameters: Record<string, string> };

export type ScheduleFields = Pick<Schedule, 'cron' | 'timezone' | 'enabled' | 'misfire' | 'parameters' | 'input'>;

/** the time zones the browser knows (IANA), the viewer's first */
export function timeZones(): string[] {
    const own = browserTimeZone();
    const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];
    return [own, ...all.filter(zone => zone !== own)];
}

export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** the expression in words ("At 09:00, Monday through Friday"), or undefined when it is not valid */
export function describeCron(cron: string): string | undefined {
    try {
        return cronstrue.toString(cron.trim(), { use24HourTimeFormat: true, verbose: false });
    } catch {
        return undefined;
    }
}

/** the shortcuts of the form: each one a cron expression */
export type CronPreset = {
    id: string;
    label: string;
    cron: (value: number, time: string) => string;
    value?: 'seconds' | 'minutes' | 'time';
};

const hm = (time: string) => {
    const [h = '0', m = '0'] = time.split(':');
    return { h: String(Number(h)), m: String(Number(m)) };
};

export const CRON_PRESETS: CronPreset[] = [
    { id: 'seconds', label: 'Every N seconds', value: 'seconds', cron: n => `*/${n} * * * * *` },
    { id: 'minutes', label: 'Every N minutes', value: 'minutes', cron: n => `*/${n} * * * *` },
    { id: 'hourly', label: 'Every hour', cron: () => '0 * * * *' },
    { id: 'daily', label: 'Every day at', value: 'time', cron: (_, time) => `${hm(time).m} ${hm(time).h} * * *` },
    { id: 'weekdays', label: 'Weekdays at', value: 'time', cron: (_, time) => `${hm(time).m} ${hm(time).h} * * 1-5` },
    { id: 'custom', label: 'Custom', cron: () => '' },
];
