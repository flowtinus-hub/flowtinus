import { LOOP, MAX_SUB_RUNS, type ComponentRun, type LogLine, type RunProgress, type RunRecord, type SubRun } from '@flowtinus/core';

/** a run as the panel shows it: ended, or still going */
export type Shown = RunRecord | RunProgress;

const total = (ports: Record<string, number>) => Object.values(ports).reduce((n, v) => n + v, 0);

/** the components the Data tab lists: all but an End nothing reached */
export const dataTabComponents = (record: Shown, iterationOf?: (loopId: string) => number) =>
    dataTabRows(record, iterationOf).map(row => row.c);

/**
 * The Data tab's rows: each component, and under each Loop (one step in) the components of its loop region in the
 * iteration the canvas shows for it (the first unless picked; their Start and End left out), down nested Loops.
 */
export function dataTabRows(record: Shown, iterationOf: (loopId: string) => number = () => 0): { c: ComponentRun; depth: number }[] {
    const rows: { c: ComponentRun; depth: number }[] = [];
    const add = (components: ComponentRun[], depth: number) => {
        for (const c of components) {
            if (depth > 0 ? c.type === 'start' || c.type === 'end' : c.type === 'end' && total(c.inputs) === 0) {
                continue;
            }
            rows.push({ c, depth });
            const iterations = c.type === LOOP ? (c.subRuns ?? []) : [];
            const shown = iterations[iterationOf(c.nodeId)] ?? iterations[0];
            if (shown?.record) {
                add(shown.record.components, depth + 1);
            }
        }
    };
    add(record.components, 0);
    return rows;
}

/**
 * The component the Data tab shows: the one chosen, kept from run to run (while a run has not reached it yet, it waits
 * on it); the first after the Start when nothing was chosen, or when a run ended without it (removed from the flow).
 */
export function dataTabSelection(record: Shown, chosen: string | undefined, iterationOf?: (loopId: string) => number): string | undefined {
    const shown = dataTabComponents(record, iterationOf);
    if (chosen && (record.status === 'running' || shown.some(c => c.nodeId === chosen))) {
        return chosen;
    }

    return shown.find(c => c.type !== 'start')?.nodeId ?? shown[0]?.nodeId;
}

/** how long the timeline's axis is: the run's duration, or where the last component closed if that is later */
export function timelineSpan(record: Shown, runStart: number): number {
    return Math.max(record.durationMs, ...record.components.map(c => (c.start ? Date.parse(c.start) - runStart + (c.durationMs ?? 0) : 0)));
}

/**
 * one error of a run, stacked: the component, the message and how many times it came (the first time); one from a flow
 * a Flow Invoker called says where (`via`: the flow and the component in it, down the chain), under the Flow Invoker
 */
export type RunError = { nodeId: string; message: string; count: number; at: string; via?: string };

/** a component's name as the panel shows it, without the catalog: its label, or its type */
const labelOf = (c: ComponentRun) => c.label || c.type;

/** the sub-runs of a component that have a record (the first MAX_SUB_RUNS calls of a Flow Invoker) */
export const subRunsOf = (c: ComponentRun): (SubRun & { record: RunRecord | RunProgress })[] =>
    (c.subRuns ?? []).filter((s): s is SubRun & { record: RunRecord | RunProgress } => !!s.record);

/**
 * how many sub-runs the record kept, said truthfully: a Loop's iterations past MAX_SUB_RUNS are not counted anywhere, so
 * at the cap it says the run keeps no more; a Flow Invoker's against its calls (one per envelope in)
 */
export const keptSubRuns = (c: ComponentRun) => {
    const kept = c.subRuns?.length ?? 0;
    if (c.type === LOOP) {
        return kept >= MAX_SUB_RUNS ? `${kept}: a run keeps the first ${MAX_SUB_RUNS}` : String(kept);
    }
    const calls = Object.values(c.inputs).reduce((n, v) => n + v, 0);
    return kept === calls ? String(kept) : `the first ${kept} of ${calls} calls`;
};

/** a Flow Invoker's fire and forget calls of a real run: queued as runs of their own (no record here, their own) */
export const queuedRunsOf = (c: ComponentRun): SubRun[] => (c.subRuns ?? []).filter(s => s.status === 'queued');

/** the End's closing line ("Run … finished (Failed) …"): a summary, not an error of its own */
const CLOSING_LINE = /^Run \S+ finished \(/;

/** whether a line is an error the engine wrote (not the End's closing line, nor what a component logs at that level) */
const isError = (c: ComponentRun, line: LogLine) =>
    line.level === 'error' && !line.byComponent && !(c.type === 'end' && CLOSING_LINE.test(line.message));

/**
 * A line that only passes on the error of a flow called in this run ("The flow "X" failed: …") whose own lines are in
 * its record: that error is listed where it happened (under the Flow Invoker), not once more at each level up. The
 * line is the Flow Invoker's (On error Throw) or a component's after it that throws it again (e.g. a TypeScript
 * component fed by its error port).
 */
const relays = (shown: Shown, line: LogLine) =>
    shown.components.some(c =>
        subRunsOf(c).some(
            sub =>
                line.message.includes(`The flow "${sub.flow}" failed: `) &&
                sub.record.components.some(s => s.logs.some(l => isError(s, l))),
        ),
    );

/**
 * The run's errors, from the error lines the engine wrote (not the log's other lines, nor what a component logs at
 * the error level, e.g. a Log set to Error): the same message of the same component once, with its count, in the
 * order they first came. An error in a called flow is listed once, where it happened, with the calls down to it.
 */
export function runErrors(record: Shown): RunError[] {
    const stacked = new Map<string, RunError>();
    // the lines of a run, and of the runs its Flow Invokers called: those under the Flow Invoker, with where they came from
    const collect = (shown: Shown, nodeId: string | undefined, via: string) => {
        for (const c of shown.components) {
            for (const line of c.logs) {
                if (!isError(c, line) || relays(shown, line)) {
                    continue;
                }

                const where = via ? `${via} › ${labelOf(c)}` : '';
                const key = `${nodeId ?? c.nodeId}\n${where}\n${line.message}`;
                const seen = stacked.get(key);
                if (seen) {
                    seen.count += 1;
                } else {
                    stacked.set(key, {
                        nodeId: nodeId ?? c.nodeId,
                        message: line.message,
                        count: 1,
                        at: line.at,
                        ...(where ? { via: where } : {}),
                    });
                }
            }

            for (const sub of subRunsOf(c)) {
                collect(sub.record, nodeId ?? c.nodeId, via ? `${via} › ${sub.flow}` : sub.flow);
            }
        }
    };
    collect(record, undefined, '');
    return [...stacked.values()].sort((a, b) => a.at.localeCompare(b.at));
}
