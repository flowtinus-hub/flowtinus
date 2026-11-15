import { parseEvents } from '@/data/flows/run-events';
import { api, apiHeaders, type ApiResult } from '@/lib/api';
import type { Supervisor, WorkersOverview } from './worker';

/*
 * The environment's supervisors on flowtinus.server (GET /workers): each one's tags, workers and how many are busy,
 * and the runs waiting per tag. Dates come as ISO text and become Date here.
 */

type SupervisorDto = Omit<Supervisor, 'startedAt' | 'lastSeen' | 'version' | 'host' | 'color' | 'fireAndForgetPerWorker'> & {
    color?: string | null;
    fireAndForgetPerWorker?: number | null;
    host: string;
    version: string | null;
    startedAt: string;
    lastSeen: string;
};

/** the host of a supervisor that did not say it (registered before it did): its id's start, without the pid and the random part */
const hostOf = (dto: SupervisorDto) => dto.host || dto.id.split('-').slice(0, -2).join('-') || dto.id;

export const toSupervisor = (dto: SupervisorDto): Supervisor => ({
    ...dto,
    host: hostOf(dto),
    version: dto.version ?? '',
    color: dto.color ?? null,
    fireAndForgetPerWorker: dto.fireAndForgetPerWorker ?? null,
    startedAt: new Date(dto.startedAt),
    lastSeen: new Date(dto.lastSeen),
});

export async function getWorkersOverview(): Promise<ApiResult<WorkersOverview>> {
    const result = await api<Omit<WorkersOverview, 'supervisors'> & { supervisors: SupervisorDto[] }>('/workers');
    return result.ok ? { ok: true, value: { ...result.value, supervisors: result.value.supervisors.map(toSupervisor) } } : result;
}

/** a stream silent for this long is taken for dead (the server writes every couple of seconds) */
const SILENT_MS = 15_000;

/**
 * Follows the Workers page's data (GET /workers/events, SSE, read with fetch so it carries the api's headers): all of
 * it when the stream opens and whenever it changes. Resolves when the stream ends, fails or goes silent.
 */
export async function followWorkers(onValue: (value: WorkersOverview) => void, signal: AbortSignal, silentMs = SILENT_MS): Promise<void> {
    const own = new AbortController();
    const stop = () => own.abort();
    signal.addEventListener('abort', stop);
    let heard = Date.now();
    const watchdog = setInterval(() => Date.now() - heard > silentMs && stop(), Math.min(5000, silentMs / 2));
    try {
        const response = await fetch('/api/workers/events', {
            headers: { ...apiHeaders(), accept: 'text/event-stream' },
            signal: own.signal,
        });
        if (!response.ok || !response.body) {
            return;
        }

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) {
                return;
            }

            heard = Date.now();
            const parsed = parseEvents(buffer + value.replace(/\r\n/g, '\n'));
            buffer = parsed.rest;
            for (const event of parsed.events) {
                if (event.type === 'workers') {
                    const dto = JSON.parse(event.data) as Omit<WorkersOverview, 'supervisors'> & { supervisors: SupervisorDto[] };
                    onValue({ ...dto, supervisors: dto.supervisors.map(toSupervisor) });
                }
            }
        }
    } catch {
        // aborted, silent for too long, or the connection dropped
    } finally {
        clearInterval(watchdog);
        signal.removeEventListener('abort', stop);
    }
}
