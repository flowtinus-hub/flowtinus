import type { QueueFlow, RunProgress, RunRecord, SendHttp } from '@flowtinus/core';
import { runJob, type RunJob } from '#features/runs/run-job';
import type { RunUsage } from '#features/runs/run-queue';

export type Execution = { done: Promise<{ record: RunRecord; usage: RunUsage }>; cancel(): void };

export type RunHooks = { queueFlow?: QueueFlow };

export interface Executor {
    readonly size: number;
    run(job: RunJob, onProgress: (progress: RunProgress) => void, hooks?: RunHooks): Execution;
    close(): Promise<void>;
}

export function inProcessExecutor(options: { size?: number; http?: SendHttp } = {}): Executor {
    return {
        size: options.size ?? 4,
        run(job, onProgress, hooks = {}) {
            const abort = new AbortController();
            const startRssBytes = process.memoryUsage().rss;
            const cpu = process.cpuUsage();
            const done = runJob(job, { http: options.http, onProgress, signal: abort.signal, queueFlow: hooks.queueFlow }).then(record => {
                const used = process.cpuUsage(cpu);
                return {
                    record,
                    usage: {
                        startRssBytes,
                        peakRssBytes: Math.max(startRssBytes, process.memoryUsage().rss),
                        cpuMs: (used.user + used.system) / 1000,
                    },
                };
            });
            return { done, cancel: () => abort.abort() };
        },
        close: async () => {},
    };
}
