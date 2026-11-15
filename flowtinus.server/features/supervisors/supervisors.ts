import type { Database } from '#shared/database/database';

/*
 * The supervisors of this instance (the supervisors table): each one takes the runs of its tags (WORKER_TAGS) with its
 * workers (WORKERS) and says it is alive (last_seen) every few seconds. A flow's tag says which of them run it; a tag
 * no live supervisor has would keep its runs queued forever, so a run of it is refused instead.
 */

/** a supervisor not seen for this long is lost (the same wait as a run's heartbeat: run-queue's STALE_AFTER_MS) */
export const SUPERVISOR_LOST_AFTER_MS = 60_000;

export const WORKER_TAG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const DEFAULT_WORKER_TAG = 'default';

export function workerTagError(tag: string): string | undefined {
    if (tag === '') {
        return 'Required';
    }

    return WORKER_TAG.test(tag) ? undefined : "Lowercase letters, digits, '-' and '_' only (up to 40)";
}

export async function hasLiveSupervisor(db: Database, tag: string): Promise<boolean> {
    const [row] = await db.query<{ live: boolean }>(
        `SELECT EXISTS (
       SELECT 1 FROM supervisors WHERE $1 = ANY(tags) AND last_seen > now() - make_interval(secs => $2)
     ) AS live`,
        [tag, SUPERVISOR_LOST_AFTER_MS / 1000],
    );
    return Boolean(row?.live);
}

export const noSupervisorFor = (tag: string) =>
    `No worker takes the tag "${tag}" in this environment: start a supervisor with it in WORKER_TAGS, or change the flow's tag.`;

export type SupervisorView = {
    id: string;
    host: string;
    tags: string[];
    workers: number;
    busy: number;
    version: string | null;
    color: string | null;
    fireAndForgetPerWorker: number | null;
    startedAt: Date;
    lastSeen: Date;
};

export type WorkersView = {
    environment: string;
    supervisors: SupervisorView[];
    queuedByTag: Record<string, number>;
};

export async function listWorkers(db: Database, environment: string): Promise<WorkersView> {
    const supervisors = await db.query<SupervisorView>(
        `SELECT s.id, coalesce(s.host, '') AS host, s.tags, s.workers, s.version, s.color, s.fire_and_forget_per_worker AS "fireAndForgetPerWorker", s.started_at AS "startedAt", s.last_seen AS "lastSeen",
            (SELECT count(*) FROM runs r WHERE r.status = 'running' AND r.worker_id = s.id)::int
              + (SELECT count(*) FROM test_runs t WHERE t.status = 'running' AND t.worker_id = s.id)::int AS busy
     FROM supervisors s ORDER BY s.started_at, s.id`,
    );
    const queued = await db.query<{ tag: string; queued: number }>(
        `SELECT worker_tag AS tag, count(*)::int AS queued FROM (
       SELECT worker_tag FROM runs WHERE status = 'queued'
       UNION ALL SELECT worker_tag FROM test_runs WHERE status = 'queued'
     ) q GROUP BY worker_tag`,
    );
    return {
        environment,
        supervisors: supervisors.map(s => ({
            ...s,
            busy: Number(s.busy),
            workers: Number(s.workers),
            startedAt: new Date(s.startedAt),
            lastSeen: new Date(s.lastSeen),
        })),
        queuedByTag: Object.fromEntries(queued.map(q => [q.tag, Number(q.queued)])),
    };
}
