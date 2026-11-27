import { useEffect, useSyncExternalStore } from 'react';
import { LOCAL_ENVIRONMENT } from '@flowtinus/core';

/*
 * Whether flowtinus.server answers, shared by the whole app. Nothing polls while online: the app's own requests
 * (api.ts) tell it, a request that cannot reach the server marks it offline at once, and GET /api/health (it needs
 * no X-Workspace-Id) is asked once when the app starts, when the browser goes back online or the tab is shown again, and
 * while offline, again with a growing wait (1 s, 2 s, 4 s... up to 15 s) until it comes back.
 */

export type ServerConnection = { state: 'checking' } | { state: 'online'; environment: string } | { state: 'offline' };

export type ServerKind = 'unknown' | 'local' | 'server';

const TIMEOUT_MS = 3_000;
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 15_000;

/** the wait before the nth check while offline (0, 1, 2...): doubling, up to the maximum */
export const retryDelay = (attempt: number) => Math.min(RETRY_FIRST_MS * 2 ** attempt, RETRY_MAX_MS);

/** the server's environment (DEV, STAGING...) when /health answered 2xx in time; null otherwise */
export async function pingServer(timeoutMs = TIMEOUT_MS): Promise<string | null> {
    try {
        const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) {
            return null;
        }

        const body = (await response.json().catch(() => ({}))) as { environment?: unknown };
        return typeof body.environment === 'string' ? body.environment : '';
    } catch {
        return null;
    }
}

// ---- the shared state

let connection: ServerConnection = { state: 'checking' };
let lastEnvironment: string | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
let watchers = 0;

function set(next: ServerConnection) {
    if (
        next.state === connection.state &&
        (next.state !== 'online' || connection.state !== 'online' || next.environment === connection.environment)
    ) {
        return;
    }

    connection = next;
    if (next.state === 'online') {
        lastEnvironment = next.environment;
    }
    listeners.forEach(listener => listener());
}

/** the next check, while offline: soon and later each time; none while online (the app's requests tell) */
function schedule() {
    clearTimeout(timer);
    if (watchers === 0 || connection.state !== 'offline') {
        return;
    }

    timer = setTimeout(() => void check(), retryDelay(attempt++));
}

/** checks now (a hidden tab waits until it is shown, when it checks again) */
export async function check(): Promise<void> {
    if (typeof document !== 'undefined' && document.hidden) {
        return;
    }

    const environment = await pingServer();
    if (environment === null) {
        set({ state: 'offline' });
    } else {
        attempt = 0;
        set({ state: 'online', environment });
    }

    schedule();
}

/** a request could not reach the server: offline now, and the retries start */
export function reportUnavailable(): void {
    if (connection.state !== 'offline') {
        attempt = 0;
    }

    set({ state: 'offline' });
    schedule();
}

/** a request got an answer from the server: when it was not known to be online (and someone watches), /health says the environment */
export function reportReachable(): void {
    if (watchers > 0 && connection.state !== 'online') {
        void check();
    }
}

export const serverConnection = () => connection;

/** subscribes to the state; the first subscriber starts the checks, the last one stops them */
export function watchServer(listener: () => void): () => void {
    listeners.add(listener);
    watchers += 1;
    if (watchers === 1) {
        void check();
    }

    return () => {
        listeners.delete(listener);
        watchers -= 1;
        if (watchers === 0) {
            clearTimeout(timer);
        }
    };
}

export function useServerConnection(): ServerConnection {
    const current = useSyncExternalStore(watchServer, serverConnection, serverConnection);

    useEffect(() => {
        const now = () => void check();
        const offline = () => reportUnavailable();
        window.addEventListener('online', now);
        window.addEventListener('offline', offline);
        document.addEventListener('visibilitychange', now);
        return () => {
            window.removeEventListener('online', now);
            window.removeEventListener('offline', offline);
            document.removeEventListener('visibilitychange', now);
        };
    }, []);

    return current;
}

/** unknown only until /health first answers: offline afterwards keeps the kind last answered */
export function useServerKind(): ServerKind {
    useServerConnection();
    if (lastEnvironment === null) {
        return 'unknown';
    }
    return lastEnvironment === LOCAL_ENVIRONMENT ? 'local' : 'server';
}

export const useLocalServer = () => useServerKind() === 'local';
