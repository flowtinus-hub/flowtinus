export type HttpRetry = { retries: number; statuses: number[]; maxWaitMs: number };
export const RETRY_BASE_MS = 1000;

export function retryAfterMs(header: string | undefined, now = Date.now()): number | undefined {
    const value = header?.trim();
    if (!value) {
        return undefined;
    }
    if (/^\d+$/.test(value)) {
        return Number(value) * 1000;
    }
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export function retryDelayMs(
    attempt: number,
    retryAfter: string | undefined,
    maxWaitMs: number,
    now = Date.now(),
    random = Math.random,
): number | undefined {
    const asked = retryAfterMs(retryAfter, now);
    if (asked !== undefined) {
        return asked <= maxWaitMs ? asked : undefined;
    }
    return Math.round(random() * Math.min(maxWaitMs, RETRY_BASE_MS * 2 ** attempt));
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(Object.assign(new Error('Request cancelled.'), { name: 'AbortError' }));
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', stop);
            resolve();
        }, ms);
        const stop = () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('Request cancelled.'), { name: 'AbortError' }));
        };
        signal.addEventListener('abort', stop, { once: true });
    });
}
