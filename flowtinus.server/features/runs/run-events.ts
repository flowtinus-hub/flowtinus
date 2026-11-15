import type { RunProgress, RunRecord } from '@flowtinus/core';
import type { Database } from '#shared/database/database';
import type { RunUsageView } from './get-run/get-run-handler';
import { CHANNELS, findRun, type RunEventNotice } from './run-queue';

export type RunEvent = { type: 'progress'; progress: RunProgress } | { type: 'done'; record: RunRecord; usage?: RunUsageView | null };

const listeners = new Map<string, Set<(event: RunEvent) => void>>();

export type RunChange = { id: string; rootId: string; status: string };

const workspaceListeners = new Map<string, Set<(change: RunChange) => void>>();

export const workspaceRunEvents = {
    publish(workspaceId: string, change: RunChange) {
        workspaceListeners.get(workspaceId)?.forEach(listener => listener(change));
    },
    subscribe(workspaceId: string, listener: (change: RunChange) => void): () => void {
        const set = workspaceListeners.get(workspaceId) ?? new Set();
        set.add(listener);
        workspaceListeners.set(workspaceId, set);
        return () => {
            set.delete(listener);
            if (set.size === 0 && workspaceListeners.get(workspaceId) === set) {
                workspaceListeners.delete(workspaceId);
            }
        };
    },
};

export const runEvents = {
    publish(runId: string, event: RunEvent) {
        listeners.get(runId)?.forEach(listener => listener(event));
        if (event.type === 'done') {
            listeners.delete(runId);
        }
    },
    followed: (runId: string) => (listeners.get(runId)?.size ?? 0) > 0,
    subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
        const set = listeners.get(runId) ?? new Set();
        set.add(listener);
        listeners.set(runId, set);
        return () => {
            set.delete(listener);
            if (set.size === 0 && listeners.get(runId) === set) {
                listeners.delete(runId);
            }
        };
    },
};

export async function followRunEvents(db: Database): Promise<() => Promise<void>> {
    const reading = new Map<string, Promise<void>>();
    const again = new Set<string>();

    const read = async (id: string) => {
        const row = await findRun(db, id);
        if (!row) {
            runEvents.publish(id, { type: 'done', record: replacedRecord(id) });
            return;
        }

        if (row.status !== 'queued' && row.status !== 'running' && row.record) {
            runEvents.publish(id, { type: 'done', record: row.record as RunRecord, usage: usageOf(row) });
        } else if (row.status === 'running' && row.progress) {
            runEvents.publish(id, { type: 'progress', progress: row.progress as RunProgress });
        }
    };

    const onNotice = (payload: string) => {
        let notice: RunEventNotice;
        try {
            notice = JSON.parse(payload) as RunEventNotice;
        } catch {
            return;
        }

        // the Runs page's stream: a new status (never the progress, a few times a second), told without reading the row
        if (notice.type !== 'progress' && notice.workspaceId && notice.status) {
            workspaceRunEvents.publish(notice.workspaceId, { id: notice.id, rootId: notice.rootId ?? notice.id, status: notice.status });
        }

        if (notice.type === 'status' || !runEvents.followed(notice.id)) {
            return;
        }

        if (reading.has(notice.id)) {
            again.add(notice.id);
            return;
        }

        const loop = async () => {
            do {
                again.delete(notice.id);
                await read(notice.id).catch(() => {});
            } while (again.has(notice.id));
            reading.delete(notice.id);
        };
        reading.set(notice.id, loop());
    };

    return db.listen(CHANNELS.events, onNotice);
}

export const replacedRecord = (id: string): RunRecord => ({
    run: { id, mode: 'validation', workspace: '', project: '', flow: '', startedAt: new Date().toISOString() },
    parameters: {},
    status: 'failed',
    end: new Date().toISOString(),
    durationMs: 0,
    error: 'A newer test run of this flow replaced it.',
    components: [],
});

/** what a run's worker used, from its row (bigint columns may come back as text) */
export function usageOf(row: { startRssBytes: unknown; peakRssBytes: unknown; cpuMs: unknown }): RunUsageView | null {
    const count = (value: unknown) => (value === null || value === undefined ? null : Number(value));
    const usage = { startRssBytes: count(row.startRssBytes), peakRssBytes: count(row.peakRssBytes), cpuMs: count(row.cpuMs) };
    return usage.peakRssBytes === null && usage.cpuMs === null ? null : usage;
}
