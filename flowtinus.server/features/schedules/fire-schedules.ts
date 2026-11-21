import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '#shared/database/database';
import type { FlowFile } from '@flowtinus/core';
import { deployedRun } from '#features/runs/deployed-run';
import { runs, type RunRowStatus } from '#features/runs/run';
import { CHANNELS, lostRecord, notifyRunEvent } from '#features/runs/run-queue';
import { dueTimes, nextTime, type MisfireMode } from '@flowtinus/core';

/*
 * Firing the schedules that are due, by any supervisor (each one calls fireDueSchedules on its timer and its poll):
 * the due rows are locked with FOR UPDATE SKIP LOCKED, so two supervisors never fire the same one, and each one's runs
 * and its next time are written in the same transaction (a supervisor that dies halfway leaves nothing done: another
 * one fires it). A unique index on (schedule_id, scheduled_for) makes a time queue one run whatever happens.
 */

/** a time later than this is missed (the supervisors were down): what happens to it is the schedule's misfire mode */
export const MISFIRE_THRESHOLD_MS = 60_000;
const BATCH = 20;
export const STRICT_LIMIT = 100;

type DueRow = {
    id: string;
    workspace_id: string;
    project_id: string;
    flow_id: string;
    cron: string;
    timezone: string;
    misfire: MisfireMode;
    parameters: Record<string, string>;
    input: unknown;
    next_fire_at: Date;
    flow_name: string;
    worker_tag: string;
    flow_archived: boolean;
    workspace_archived: boolean;
    version_id: string | null;
    definition: FlowFile | null;
};

export function timesToRun(due: Date[], now: Date, misfire: MisfireMode): Date[] {
    const missed = due.filter(at => now.getTime() - at.getTime() > MISFIRE_THRESHOLD_MS);
    const onTime = due.filter(at => !missed.includes(at));
    if (missed.length === 0 || misfire === 'ignorable') {
        return onTime;
    }

    if (misfire === 'strict') {
        return due;
    }

    // relaxed: once for all the missed ones (none more when one runs on time anyway)
    return onTime.length > 0 ? onTime : [missed[missed.length - 1]!];
}

type Fired = { runId: string; status: 'queued' | 'skipped' | 'failed'; tag: string; workspaceId: string } | { error: string };

async function endedRun(tx: Database, row: DueRow, at: Date, status: 'skipped' | 'failed', error: string): Promise<string | null> {
    const id = crypto.randomUUID();
    const now = new Date();
    const record = { ...lostRecord({ id, mode: 'execution', progress: null, startedAt: now, queuedAt: now }, error), durationMs: 0 };
    const [inserted] = await tx.orm
        .insert(runs)
        .values({
            id,
            workspaceId: row.workspace_id,
            flowId: row.flow_id,
            projectId: row.project_id,
            mode: 'execution',
            ...(row.version_id ? { flowVersionId: row.version_id } : { draftHash: 'none' }),
            status,
            trigger: 'schedule',
            workerTag: row.worker_tag,
            parameters: row.parameters,
            flowName: row.flow_name,
            finishedAt: now,
            durationMs: 0,
            record,
            error,
            scheduleId: row.id,
            scheduledFor: at,
        })
        .onConflictDoNothing()
        .returning({ id: runs.id });
    return inserted?.id ?? null;
}

async function fireOne(tx: Database, row: DueRow, at: Date): Promise<Fired> {
    if (row.workspace_archived) {
        return { error: 'Its workspace was archived.' };
    }
    if (row.flow_archived) {
        return { error: 'Its flow was archived.' };
    }

    if (!row.version_id || !row.definition) {
        return { error: 'The flow is not deployed.' };
    }

    const ended = async (status: 'skipped' | 'failed', error: string): Promise<Fired> => {
        const id = await endedRun(tx, row, at, status, error);
        return id ? { runId: id, status, tag: row.worker_tag, workspaceId: row.workspace_id } : { error: 'Already fired.' };
    };

    const [open] = await tx.orm
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.scheduleId, row.id), inArray(runs.status, ['queued', 'running'])))
        .orderBy(desc(runs.queuedAt))
        .limit(1);
    if (open) {
        return ended('skipped', `Skipped: its previous run (${open.id}) was still running.`);
    }

    const prepared = await deployedRun(
        tx,
        {
            workspaceId: row.workspace_id,
            projectId: row.project_id,
            flowId: row.flow_id,
            flowName: row.flow_name,
            workerTag: row.worker_tag,
            versionId: row.version_id,
            definition: row.definition,
        },
        'schedule',
        row.parameters,
        row.input ?? undefined,
    );
    if (!prepared.ok) {
        return ended('failed', prepared.error);
    }

    const [inserted] = await tx.orm
        .insert(runs)
        .values({ ...prepared.values, scheduleId: row.id, scheduledFor: at })
        .onConflictDoNothing()
        .returning({ id: runs.id });
    return inserted
        ? { runId: inserted.id, status: 'queued', tag: row.worker_tag, workspaceId: row.workspace_id }
        : { error: 'Already fired.' };
}

export type FireResult = { schedules: number; runs: { runId: string; status: 'queued' | 'skipped' | 'failed'; scheduleId: string }[] };

export async function fireDueSchedules(db: Database, now?: Date): Promise<FireResult> {
    const at = now ?? (await db.query<{ now: Date }>('SELECT now() AS now'))[0]!.now;
    const result: FireResult = { schedules: 0, runs: [] };
    const queued: { runId: string; tag: string; workspaceId: string; status: string }[] = [];
    for (;;) {
        const count = await db.transaction(async tx => {
            const due = await tx.query<DueRow>(
                `SELECT s.id, s.workspace_id, s.project_id, s.flow_id, s.cron, s.timezone, s.misfire, s.parameters, s.input, s.next_fire_at,
           f.name AS flow_name, f.worker_tag, (f.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL) AS flow_archived,
           (ws.deleted_at IS NOT NULL) AS workspace_archived,
           v.id AS version_id, v.definition
         FROM flow_schedules s
         JOIN flows f ON f.id = s.flow_id
         JOIN projects p ON p.id = s.project_id
         JOIN workspaces ws ON ws.id = s.workspace_id
         LEFT JOIN deployments d ON d.flow_id = s.flow_id
         LEFT JOIN flow_versions v ON v.id = d.flow_version_id
         WHERE s.enabled AND s.next_fire_at <= $1
         ORDER BY s.next_fire_at
         LIMIT ${BATCH}
         FOR UPDATE OF s SKIP LOCKED`,
                [at],
            );
            for (const row of due) {
                const first = new Date(row.next_fire_at);
                const times = timesToRun(dueTimes(row.cron, row.timezone, first, at, STRICT_LIMIT), at, row.misfire);
                let last: { at: Date; runId: string } | null = null;
                let error: string | null = null;
                for (const time of times) {
                    const fired = await fireOne(tx, row, time);
                    if ('error' in fired) {
                        error = fired.error;
                        continue;
                    }

                    last = { at: time, runId: fired.runId };
                    result.runs.push({ runId: fired.runId, status: fired.status, scheduleId: row.id });
                    queued.push(fired);
                }

                const next = nextTime(row.cron, row.timezone, at);
                await tx.query(
                    `UPDATE flow_schedules SET next_fire_at = $2, last_fired_at = coalesce($3, last_fired_at),
             last_run_id = coalesce($4, last_run_id), last_error = $5 WHERE id = $1`,
                    [row.id, next, last?.at ?? null, last?.runId ?? null, last ? null : error],
                );
            }

            return due.length;
        });
        result.schedules += count;
        if (count < BATCH) {
            break;
        }
    }

    for (const run of queued) {
        await notifyRunEvent(db, {
            id: run.runId,
            type: 'status',
            workspaceId: run.workspaceId,
            rootId: run.runId,
            status: run.status as RunRowStatus,
        });
    }

    for (const tag of new Set(queued.filter(r => r.status === 'queued').map(r => r.tag))) {
        await db.notify(CHANNELS.queued, tag);
    }

    return result;
}

export async function nextDue(db: Database): Promise<Date | null> {
    const [row] = await db.query<{ at: Date | null }>('SELECT min(next_fire_at) AS at FROM flow_schedules WHERE enabled');
    return row?.at ? new Date(row.at) : null;
}
