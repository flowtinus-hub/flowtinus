/*
 * The environment's workers as the Workers page shows them: the supervisors (one per container) that run the queued
 * runs, each with its tags (WORKER_TAGS) and its worker processes (WORKERS), and per tag what serves it and what waits.
 * A run goes to a supervisor that has its flow's tag; a tag no live supervisor has keeps its runs queued.
 */

/** a supervisor is alive while it says so (last_seen); past STALE_AFTER_MS without it, it is lost */
export const STALE_AFTER_MS = 60_000;

/** one supervisor process (a container): its tags and its workers, how many run a run now */
export type Supervisor = {
    id: string;
    /** the container's host name */
    host: string;
    tags: string[];
    workers: number;
    busy: number;
    version: string;
    /** its tags' color on the screens (WORKER_COLOR of its container), #rrggbb; null = none */
    color: string | null;
    /** how many runs one Flow Invoker may fire and forget in a run, per worker (FIRE_AND_FORGET_PER_WORKER); null = not said */
    fireAndForgetPerWorker: number | null;
    startedAt: Date;
    lastSeen: Date;
};

/** what the page loads: the supervisors and, per tag, the runs waiting for a worker */
export type WorkersOverview = {
    environment: string;
    supervisors: Supervisor[];
    queuedByTag: Record<string, number>;
};

export type SupervisorHealth = 'online' | 'lost';

export const healthOf = (supervisor: Pick<Supervisor, 'lastSeen'>, now = new Date()): SupervisorHealth =>
    now.getTime() - supervisor.lastSeen.getTime() > STALE_AFTER_MS ? 'lost' : 'online';

/** a tag: the live supervisors that take its runs, their workers (all and busy), the runs waiting */
export type TagSummary = {
    tag: string;
    supervisors: number;
    workers: number;
    busy: number;
    queued: number;
    /** the color its live supervisors give it when they all share it; null = none, or supervisors of different colors (or none) share the tag */
    color: string | null;
    /** runs wait and no live supervisor has the tag: they stay queued until one starts */
    unserved: boolean;
};

/**
 * One line per tag, of the live supervisors and of the queued runs (a tag with runs waiting and no supervisor shows
 * too): unserved first, then by name. A supervisor of several tags counts in each (its workers take any of them).
 */
export function summarizeTags(overview: Pick<WorkersOverview, 'supervisors' | 'queuedByTag'>, now = new Date()): TagSummary[] {
    const byTag = new Map<string, TagSummary>();
    // a tag served by a supervisor without a color and by a pink one (default, say) is neither: it stays without one
    const colorsOf = new Map<string, Set<string | null>>();
    const entry = (tag: string) => {
        let summary = byTag.get(tag);
        if (!summary) {
            summary = { tag, supervisors: 0, workers: 0, busy: 0, queued: 0, color: null, unserved: false };
            byTag.set(tag, summary);
        }

        return summary;
    };

    for (const supervisor of overview.supervisors.filter(s => healthOf(s, now) === 'online')) {
        for (const tag of supervisor.tags) {
            const summary = entry(tag);
            summary.supervisors += 1;
            summary.workers += supervisor.workers;
            summary.busy += supervisor.busy;
            colorsOf.set(tag, (colorsOf.get(tag) ?? new Set<string | null>()).add(supervisor.color));
        }
    }

    for (const [tag, colors] of colorsOf) {
        entry(tag).color = colors.size === 1 ? [...colors][0] : null;
    }

    for (const [tag, queued] of Object.entries(overview.queuedByTag)) {
        if (queued > 0) {
            entry(tag).queued = queued;
        }
    }

    const tags = [...byTag.values()].map(s => ({ ...s, unserved: s.queued > 0 && s.supervisors === 0 }));
    return tags.sort((a, b) => Number(b.unserved) - Number(a.unserved) || a.tag.localeCompare(b.tag));
}

/** the environment's totals: live supervisors, their workers, how many are busy */
export function totals(supervisors: Supervisor[], now = new Date()) {
    const online = supervisors.filter(s => healthOf(s, now) === 'online');
    return {
        supervisors: online.length,
        lost: supervisors.length - online.length,
        workers: online.reduce((n, s) => n + s.workers, 0),
        busy: online.reduce((n, s) => n + s.busy, 0),
    };
}

/** a tag a flow may take: the live supervisors' tags (with their workers), the flow's own one too when none has it */
export type TagChoice = { tag: string; supervisors: number; workers: number; color: string | null; live: boolean };

/** what the flow's tag menu offers: every tag a live supervisor has, by name, and the current one if no live one has it */
export function tagChoices(supervisors: Supervisor[], current: string, now = new Date()): TagChoice[] {
    const live = summarizeTags({ supervisors, queuedByTag: {} }, now).map(t => ({
        tag: t.tag,
        supervisors: t.supervisors,
        workers: t.workers,
        color: t.color,
        live: true,
    }));
    const choices = live.some(t => t.tag === current)
        ? live
        : [...live, { tag: current, supervisors: 0, workers: 0, color: null, live: false }];
    return choices.sort((a, b) => a.tag.localeCompare(b.tag));
}

/** each tag's color, from its live supervisors (tags without one are left out) */
export function tagColors(supervisors: Supervisor[], now = new Date()): Record<string, string> {
    return Object.fromEntries(summarizeTags({ supervisors, queuedByTag: {} }, now).flatMap(t => (t.color ? [[t.tag, t.color]] : [])));
}
