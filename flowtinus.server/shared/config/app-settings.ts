import { LOG_FORMATS, LOG_LEVELS, type LogFormat, type ServerLogLevel } from '../logging/logger';
import { parseKeys, type KeyEntry } from '../crypto/keyring';

/*
 * The instance's configuration, read once from the environment (Bun loads flowtinus.server/.env). Each environment (DEV,
 * STAGING, PROD...) is its own instance of the product, so these values say which one this process is.
 * Settings an environment manager changes at runtime (e.g. readonly) live in the `settings` table, not here.
 */

export type AppSettings = {
    /** Postgres connection (docker-compose.yml in development); 'memory://' = PGlite in memory (tests); required to start */
    databaseUrl?: string;
    environment: string;
    port: number;
    /** how many workers the supervisor starts = how many runs it executes at the same time (one worker = one run) */
    workers: number;
    workerTags: string[];
    fireAndForgetPerWorker: number;
    workerColor?: string;
    editorUrl?: string;
    promoteTo?: string;
    /** the keys that encrypt the secrets (SECRETS_KEYS, the last one encrypts); empty = DEV's fixed key, refused elsewhere */
    secretsKeys: KeyEntry[];
    logLevel: ServerLogLevel;
    logFormat: LogFormat;
};

export class AppSettingsError extends Error {
    override name = 'AppSettingsError';
}

function integer(name: string, value: string | undefined, fallback: number, min: number): number {
    if (value === undefined || value.trim() === '') {
        return fallback;
    }

    const n = Number(value);
    if (!Number.isInteger(n) || n < min) {
        throw new AppSettingsError(`${name} must be an integer >= ${min} (got "${value}").`);
    }

    return n;
}

function list(value: string | undefined, fallback: string[]): string[] {
    const items = (value ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    return items.length > 0 ? items : fallback;
}

function url(name: string, value: string | undefined): string | undefined {
    if (!value?.trim()) {
        return undefined;
    }
    try {
        return new URL(value).toString();
    } catch {
        throw new AppSettingsError(`${name} is not a valid URL (got "${value}").`);
    }
}

function keys(value: string | undefined): KeyEntry[] {
    try {
        return parseKeys(value);
    } catch (e) {
        throw new AppSettingsError((e as Error).message);
    }
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
    const v = value?.trim().toLowerCase();
    if (!v) {
        return fallback;
    }
    if (!(allowed as readonly string[]).includes(v)) {
        throw new AppSettingsError(`${name} must be one of ${allowed.join(', ')} (got "${value}").`);
    }

    return v as T;
}

export const WORKER_COLORS: Record<string, string> = {
    red: '#ef4444',
    orange: '#f97316',
    amber: '#f59e0b',
    yellow: '#eab308',
    lime: '#84cc16',
    green: '#22c55e',
    emerald: '#10b981',
    teal: '#14b8a6',
    cyan: '#06b6d4',
    sky: '#0ea5e9',
    blue: '#3b82f6',
    indigo: '#6366f1',
    violet: '#8b5cf6',
    purple: '#a855f7',
    fuchsia: '#d946ef',
    pink: '#ec4899',
    rose: '#f43f5e',
};

function color(name: string, value: string | undefined): string | undefined {
    const v = value?.trim().toLowerCase();
    if (!v) {
        return undefined;
    }

    const named = WORKER_COLORS[v];
    if (named) {
        return named;
    }

    const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)?.[1];
    if (!hex) {
        throw new AppSettingsError(`${name} must be a color name (${Object.keys(WORKER_COLORS).join(', ')}) or #rrggbb (got "${value}").`);
    }

    return `#${hex.length === 3 ? [...hex].map(d => d + d).join('') : hex}`;
}

export function readAppSettings(env: Record<string, string | undefined> = process.env): AppSettings {
    return {
        databaseUrl: env.DATABASE_URL?.trim() || undefined,
        environment: env.ENVIRONMENT?.trim() || 'DEV',
        port: integer('API_PORT', env.API_PORT, 5190, 1),
        workers: integer('WORKERS', env.WORKERS, 1, 1),
        workerTags: list(env.WORKER_TAGS, ['default']),
        workerColor: color('WORKER_COLOR', env.WORKER_COLOR),
        fireAndForgetPerWorker: integer('FIRE_AND_FORGET_PER_WORKER', env.FIRE_AND_FORGET_PER_WORKER, 4, 1),
        editorUrl:
            url('EDITOR_URL', env.EDITOR_URL) ?? ((env.ENVIRONMENT?.trim() || 'DEV') === 'DEV' ? 'http://localhost:5180' : undefined),
        promoteTo: url('PROMOTE_TO', env.PROMOTE_TO),
        secretsKeys: keys(env.SECRETS_KEYS),
        logLevel: oneOf('LOG_LEVEL', env.LOG_LEVEL, LOG_LEVELS, 'info'),
        logFormat: oneOf('LOG_FORMAT', env.LOG_FORMAT, LOG_FORMATS, 'pretty'),
    };
}
