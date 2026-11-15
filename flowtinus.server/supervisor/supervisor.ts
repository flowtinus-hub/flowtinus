import { hostname } from 'node:os';
import type { QueueFlowRequest, RunProgress, RunRecord, SubRun } from '@flowtinus/core';
import { failedRecord, prepareJob } from '#features/runs/run-job';
import { CHANNELS, claimRun, deleteOldTestRuns, failRunsOf, finishRun, heartbeat, queueCalledRun, reapStaleRuns, saveProgress, STALE_AFTER_MS, type QueuedRun, type RunUsage } from '#features/runs/run-queue';
import type { RunRowStatus } from '#features/runs/run';
import type { Keyring } from '#shared/crypto/keyring';
import type { Database } from '#shared/database/database';
import { createLogger, type LogFields, type Logger } from '#shared/logging/logger';
import { SUPERVISOR_LOST_AFTER_MS } from '#features/supervisors/supervisors';
import { fireDueSchedules, nextDue } from '#features/schedules/fire-schedules';
import { SCHEDULES_CHANNEL } from '#features/schedules/schedules';
import type { Execution, Executor } from './workers/executor';

export type SupervisorOptions = {
    db: Database;
    keyring?: Keyring;
    /** where the runs go: worker processes, or this process (tests) */
    executor: Executor;
    tags: string[];
    id?: string;
    name?: string;
    fireAndForgetPerWorker?: number;
    color?: string;
    /** how often it looks for runs without being woken (a missed NOTIFY), reaps lost runs and says it is alive */
    pollMs?: number;
    heartbeatMs?: number;
    staleAfterMs?: number;
    logger?: Logger;
    /** fires the schedules that are due (any supervisor may: SKIP LOCKED); default true */
    schedules?: boolean;
};

type Active = { run: QueuedRun; execution: Execution | null; cancelled: boolean; writing: Promise<void>; next: RunProgress | null };

/**
 * How many runs one Flow Invoker may fire and forget in a run, per worker of the supervisor that runs it: past that,
 * its last batches grow instead (more runs than the workers can take only wait in the queue). The default of
 * SupervisorOptions.fireAndForgetPerWorker (FIRE_AND_FORGET_PER_WORKER of its container).
 */
export const FIRE_AND_FORGET_PER_WORKER = 4;

/**
 * Runs what the api queues: claims queued runs (as many as its workers), prepares each one (its secrets decrypted
 * here), hands it to a worker and writes how it goes and how it ended. Woken by NOTIFY when a run is queued or
 * stopped, and every `pollMs` in case it missed one. Several supervisors may share the database: a run goes to one.
 */
export class Supervisor {
    readonly id: string;
    private readonly logger: Logger;
    private readonly active = new Map<string, Active>();
    private readonly stops: (() => Promise<void> | void)[] = [];
    private filling: Promise<void> | null = null;
    private fillAgain = false;
    private stopped = false;
    private cleanedAt = 0;
    private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
    private firing: Promise<void> | null = null;
    private fireAgain = false;

    constructor(private readonly options: SupervisorOptions) {
        this.id = options.id ?? `${hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
        this.logger = (options.logger ?? createLogger({ service: 'supervisor' })).child({ supervisorId: this.id });
    }

    /**
     * Supervisors that are gone, and the runs they left running (they fail, with why):
     * - one not seen for SUPERVISOR_LOST_AFTER_MS, wherever it ran (its row goes: the Workers page and the tag check
     *   stop counting it);
     * - sooner, one of this host whose process is gone (a restart in development, a crash), once it also missed two
     *   heartbeats. Only the two together: the same host name with another process namespace (two containers given
     *   the same `hostname:`, another machine named alike) makes a live supervisor's pid look gone here, but that one
     *   keeps saying it is alive, so its runs are never failed.
     */
    private async reapGone() {
        const { db, heartbeatMs = 5_000 } = this.options;
        const prefix = `${hostname()}-`;
        const rows = await db.query<{ id: string; lost: boolean; quiet: boolean }>(
            `SELECT id, last_seen < now() - make_interval(secs => $2) AS lost, last_seen < now() - make_interval(secs => $3) AS quiet
       FROM supervisors WHERE id <> $1`,
            [this.id, SUPERVISOR_LOST_AFTER_MS / 1000, (2 * heartbeatMs) / 1000],
        );
        for (const { id, lost, quiet } of rows) {
            const pid = id.startsWith(prefix) ? Number(/^(\d+)-/.exec(id.slice(prefix.length))?.[1]) : NaN;
            const gone = lost || (quiet && Number.isInteger(pid) && !alive(pid));
            if (!gone) {
                continue;
            }

            for (const run of await failRunsOf(db, id, 'The supervisor running it stopped.')) {
                this.logger.warn(`Run ${run} failed: its supervisor stopped.`, { runId: run, deadSupervisorId: id });
            }

            // only while still quiet (it may have come back meanwhile)
            await db.query('DELETE FROM supervisors WHERE id = $1 AND last_seen < now() - make_interval(secs => $2)', [
                id,
                (2 * heartbeatMs) / 1000,
            ]);
        }
    }

    private async register() {
        const { db, tags, executor } = this.options;
        await db.query(
            `INSERT INTO supervisors (id, tags, workers, host, color, fire_and_forget_per_worker, last_seen) VALUES ($1, $2::text[], $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET tags = EXCLUDED.tags, workers = EXCLUDED.workers, host = EXCLUDED.host, color = EXCLUDED.color,
         fire_and_forget_per_worker = EXCLUDED.fire_and_forget_per_worker, last_seen = now()`,
            [
                this.id,
                tags,
                executor.size,
                this.options.name ?? hostname(),
                this.options.color ?? null,
                this.options.fireAndForgetPerWorker ?? FIRE_AND_FORGET_PER_WORKER,
            ],
        );
    }

    get running(): string[] {
        return [...this.active.keys()];
    }

    async start(): Promise<void> {
        const { db, tags, pollMs = 5_000, heartbeatMs = 5_000 } = this.options;
        await this.register();
        this.stops.push(
            await db.listen(CHANNELS.queued, tag => {
                if (!tag || tags.includes(tag)) {
                    this.fill();
                }
            }),
        );
        this.stops.push(await db.listen(CHANNELS.cancel, id => this.cancel(id)));

        const schedules = this.options.schedules ?? true;
        if (schedules) {
            this.stops.push(await db.listen(SCHEDULES_CHANNEL, () => this.fireSchedules()));
            this.stops.push(() => {
                if (this.scheduleTimer) {
                    clearTimeout(this.scheduleTimer);
                }
            });
        }

        const poll = setInterval(() => {
            void this.reap();
            this.fill();
            if (schedules) {
                this.fireSchedules();
            }
        }, pollMs);
        const beat = setInterval(() => void this.beat(), heartbeatMs);
        this.stops.push(
            () => clearInterval(poll),
            () => clearInterval(beat),
        );
        await this.reap();
        this.fill();
        if (schedules) {
            this.fireSchedules();
            await this.firing;
        }

        await this.filling;
    }

    fireSchedules(): void {
        if (this.stopped) {
            return;
        }

        if (this.firing) {
            this.fireAgain = true;
            return;
        }

        const { db, pollMs = 5_000 } = this.options;
        this.firing = (async () => {
            do {
                this.fireAgain = false;
                try {
                    const fired = await fireDueSchedules(db);
                    for (const run of fired.runs) {
                        this.logger.info(`schedule ${run.scheduleId}: run ${run.runId} ${run.status}`, {
                            scheduleId: run.scheduleId,
                            runId: run.runId,
                            status: run.status,
                        });
                    }
                } catch (error) {
                    this.logger.error('Could not fire the schedules.', { error });
                }
            } while (this.fireAgain && !this.stopped);

            if (this.stopped) {
                return;
            }

            const next = await nextDue(db).catch(() => null);
            if (this.scheduleTimer) {
                clearTimeout(this.scheduleTimer);
            }

            const wait = next ? Math.max(0, Math.min(pollMs, next.getTime() - Date.now())) : pollMs;
            this.scheduleTimer = setTimeout(() => this.fireSchedules(), wait);
        })().finally(() => (this.firing = null));
    }

    async stop(): Promise<void> {
        this.stopped = true;
        for (const stop of this.stops.splice(0)) {
            await stop();
        }

        await this.filling;
        await this.firing;
        const ending = [...this.active.values()].map(a => a.execution?.done);
        await this.options.executor.close();
        await Promise.all(ending);
        while (this.active.size > 0) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        await this.options.db.query('DELETE FROM supervisors WHERE id = $1', [this.id]);
    }

    fill(): void {
        if (this.stopped) {
            return;
        }

        if (this.filling) {
            this.fillAgain = true;
            return;
        }

        this.filling = (async () => {
            do {
                this.fillAgain = false;
                while (!this.stopped && this.active.size < this.options.executor.size) {
                    const run = await claimRun(this.options.db, this.options.tags, this.id).catch(error => {
                        this.logger.error('Could not claim a run.', { error });
                        return null;
                    });
                    if (!run) {
                        break;
                    }

                    this.launch(run);
                }
            } while (this.fillAgain && !this.stopped);
        })().finally(() => (this.filling = null));
    }

    private launch(run: QueuedRun) {
        const { db, keyring, executor } = this.options;
        const active: Active = { run, execution: null, cancelled: run.cancelRequested, writing: Promise.resolve(), next: null };
        this.active.set(run.id, active);
        const started = run.startedAt ?? new Date();
        const log = this.logger.child(runFields(run));
        log.debug(`Run ${run.id} claimed.`, { queuedMs: msBetween(run.queuedAt, started), running: this.active.size });

        const progress = (value: RunProgress) => {
            // one write at a time; while one goes on, only the latest waits for it
            const pending = active.next;
            active.next = value;
            if (!pending) {
                active.writing = active.writing.then(async () => {
                    const latest = active.next;
                    active.next = null;
                    if (latest) {
                        await saveProgress(db, run, latest).catch(() => {});
                    }
                });
            }
        };

        void (async () => {
            let ended;
            try {
                const job = {
                    ...(await prepareJob(db, keyring, run)),
                    maxFireAndForgetRuns: (this.options.fireAndForgetPerWorker ?? FIRE_AND_FORGET_PER_WORKER) * executor.size,
                };
                // a real run's fire and forget calls are queued here, as its children; a test run runs them beside it
                const queueFlow = run.table === 'runs' ? (request: QueueFlowRequest) => this.queueChild(run, request, log) : undefined;
                active.execution = executor.run(job, progress, { queueFlow });
                if (active.cancelled) {
                    active.execution.cancel();
                }

                ended = await active.execution.done;
            } catch (e) {
                const details = { id: run.id, mode: run.mode, workspaceName: '', projectName: '', flowName: '', startedAt: started };
                ended = { record: failedRecord(details, e instanceof Error ? e.message : String(e)), usage: {} };
                log.error(`Run ${run.id} could not start.`, { error: e });
            }

            await active.writing;
            try {
                const status = await finishRun(db, run, ended.record, ended.usage);
                if (status) {
                    logRunEnd(log, this.logger, run, status, ended.record, ended.usage, started);
                } else {
                    log.debug(`Run ${run.id} ended; a newer test run had replaced it.`);
                }
            } catch (e) {
                log.error(`Run ${run.id}: its end could not be stored.`, { error: e });
                const details = {
                    id: run.id,
                    mode: run.mode,
                    workspaceName: ended.record.run.workspace,
                    projectName: ended.record.run.project,
                    flowName: ended.record.run.flow,
                    startedAt: started,
                };
                const reason = `The run ended (${ended.record.status}) but its record could not be stored: ${e instanceof Error ? e.message : String(e)}`;
                await finishRun(db, run, failedRecord(details, reason), ended.usage).catch(() => {});
            }

            this.active.delete(run.id);
            this.fill();
        })();
    }

    cancel(id: string): void {
        const active = this.active.get(id);
        if (!active || active.cancelled) {
            return;
        }

        active.cancelled = true;
        active.execution?.cancel();
    }

    private async queueChild(parent: QueuedRun, request: QueueFlowRequest, log: Logger): Promise<{ id: string }> {
        const envelopes = Array.isArray(request.input) ? request.input.length : undefined;
        let queued;
        try {
            queued = await queueCalledRun(this.options.db, parent, request);
        } catch (e) {
            // its envelopes already went on in the parent: what was not queued is only known here and in the run's log
            log.error(`A fire and forget run of flow ${request.flowId} was not queued by run ${parent.id}.`, {
                flowId: request.flowId,
                calledBy: request.nodeLabel || undefined,
                calledByNodeId: request.nodeId,
                trigger: 'flow-invoker',
                envelopes,
                error: e,
            });
            throw e;
        }

        log.info(`Run ${queued.id} "${queued.flowName}" queued by run ${parent.id} (fire and forget)`, {
            runId: queued.id,
            parentRunId: parent.id,
            rootRunId: parent.rootId ?? parent.id,
            flowId: request.flowId,
            flow: queued.flowName,
            calledBy: request.nodeLabel || undefined,
            calledByNodeId: request.nodeId,
            trigger: 'flow-invoker',
            status: 'queued',
            envelopes,
        });
        this.fill();
        return { id: queued.id };
    }

    private async beat() {
        try {
            await heartbeat(this.options.db, this.running);
            await this.register();
        } catch (e) {
            this.logger.warn('Heartbeat failed.', { error: e });
        }
    }

    private async reap() {
        await this.reapGone().catch(error => this.logger.error('Could not check the other supervisors.', { error }));
        try {
            const reaped = await reapStaleRuns(this.options.db, this.options.staleAfterMs ?? STALE_AFTER_MS);
            for (const id of reaped) {
                this.logger.warn(`Run ${id} failed: its worker stopped answering.`, { runId: id });
            }

            if (Date.now() - this.cleanedAt > 60 * 60_000) {
                this.cleanedAt = Date.now();
                const deleted = await deleteOldTestRuns(this.options.db);
                if (deleted > 0) {
                    this.logger.debug(`${deleted} old test run(s) deleted.`, { deleted });
                }
            }
        } catch (e) {
            this.logger.error('Could not reap lost runs.', { error: e });
        }
    }
}

function runFields(run: QueuedRun): LogFields {
    return {
        runId: run.id,
        flowId: run.flowId,
        projectId: run.projectId ?? undefined,
        workspaceId: run.workspaceId,
        mode: run.mode,
        trigger: run.trigger,
        testRun: run.table === 'test_runs',
        parentRunId: run.parentId ?? undefined,
        rootRunId: run.rootId ?? run.id,
        calledByNodeId: run.parentNodeId ?? undefined,
    };
}

const total = (ports: Record<string, number>) => Object.values(ports).reduce((n, v) => n + v, 0);

/** ms from one moment to another (a row's timestamps may come as Date or as text) */
const msBetween = (from: Date | string, to: Date | string) => new Date(to).getTime() - new Date(from).getTime();

function recordFields(record: RunRecord | RunProgress): LogFields {
    const start = record.components.find(c => c.type === 'start');
    const end = record.components.find(c => c.type === 'end');
    const failing = record.components.filter(c => c.status === 'failed' || c.status === 'with-errors');
    return {
        project: record.run.project || undefined,
        flow: record.run.flow || undefined,
        envelopesIn: start ? total(start.outputs) : undefined,
        envelopesOut: end ? total(end.inputs) : undefined,
        components: record.components.length,
        failedComponents: failing.length > 0 ? failing.map(c => `${c.label || c.type} (${c.status})`).join(', ') : undefined,
    };
}

function logAtStatus(log: Logger, status: string, msg: string, fields: LogFields) {
    if (status === 'failed') {
        log.error(msg, fields);
    } else if (status === 'with-errors' || status === 'with-warnings') {
        log.warn(msg, fields);
    } else {
        log.info(msg, fields);
    }
}

const runName = (id: string, flow: string | undefined) => `Run ${id}${flow ? ` "${flow}"` : ''}`;

function calledRuns(record: RunRecord | RunProgress): { sub: SubRun; parentRunId: string; calledBy: string; calledByNodeId: string }[] {
    return record.components.flatMap(c =>
        (c.subRuns ?? []).flatMap(sub => [
            { sub, parentRunId: record.run.id, calledBy: c.label || c.type, calledByNodeId: c.nodeId },
            ...(sub.record ? calledRuns(sub.record) : []),
        ]),
    );
}

function logRunEnd(log: Logger, base: Logger, run: QueuedRun, status: RunRowStatus, record: RunRecord, usage: RunUsage, started: Date) {
    const all = calledRuns(record);
    const inside = all.filter(c => c.sub.status !== 'queued');
    const queued = all.length - inside.length;
    const rootRunId = run.rootId ?? run.id;
    const fields: LogFields = {
        ...recordFields(record),
        status,
        durationMs: Math.round(record.durationMs),
        queuedMs: msBetween(run.queuedAt, started),
        calledRuns: inside.length > 0 ? inside.length : undefined,
        queuedRuns: queued > 0 ? queued : undefined,
        from: record.from?.label,
        cpuMs: usage.cpuMs === undefined ? undefined : Math.round(usage.cpuMs),
        peakRssMb: usage.peakRssBytes === undefined ? undefined : Math.round(usage.peakRssBytes / 1024 / 1024),
        error: record.error,
    };
    logAtStatus(
        log,
        status,
        `${runName(run.id, record.run.flow)} ${status} in ${fields.durationMs} ms${record.error ? `: ${record.error}` : ''}`,
        fields,
    );

    for (const { sub, parentRunId, calledBy, calledByNodeId } of inside) {
        const subFields: LogFields = {
            at: sub.record && 'end' in sub.record ? sub.record.end : undefined,
            runId: sub.id,
            parentRunId,
            rootRunId,
            workspaceId: run.workspaceId,
            mode: run.mode,
            testRun: run.table === 'test_runs',
            trigger: 'flow-invoker',
            fireAndForget: sub.fireAndForget,
            calledBy,
            calledByNodeId,
            ...(sub.record ? recordFields(sub.record) : {}),
            flow: sub.flow,
            status: sub.status,
            durationMs: Math.round(sub.durationMs),
            error: sub.error,
        };
        const msg =
            sub.status === 'running'
                ? `${runName(sub.id, sub.flow)} still running when run ${parentRunId} ended`
                : `${runName(sub.id, sub.flow)} ${sub.status} in ${subFields.durationMs} ms (called by run ${parentRunId})${sub.error ? `: ${sub.error}` : ''}`;
        logAtStatus(base, sub.status, msg, subFields);
    }
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        // EPERM: it exists, it is someone else's
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}
