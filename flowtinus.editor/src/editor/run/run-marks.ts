import { createContext, useContext } from 'react';
import { END, LOOP, pinnedFromRun, START, type ComponentRun, type IterationOf, type EnvelopeData, type RunProgress, type RunRecord } from '@flowtinus/core';

/**
 * What the canvas shows of a run on its components: a spinner on each while it runs, then each one's status and how
 * many envelopes went through its ports (from the run's record).
 */
export type RunMarks = {
    running: boolean;
    byNode: Map<string, ComponentRun>;
    /** a click on a port's count: the run's Data tab on that component and port */
    onShow?: (nodeId: string, port: string) => void;
    /** the last full test run's components: Run from here starts from what reached them there */
    full?: Map<string, ComponentRun>;
    /** which runs these are (a Last run tab says so): the run shown, and the full test run */
    about?: RunAbout;
    fullAbout?: RunAbout;
    /** which of a Loop's kept iterations (its sub-runs) the canvas shows inside its box: 0, the first, unless picked */
    iterationOf: (loopId: string) => number;
    pickIteration?: (loopId: string, iteration: number) => void;
};

/** a run as a component's Last run tab names it: Test run or Run for real, from which component, when */
export type RunAbout = { mode: 'validation' | 'execution'; from?: string; startedAt: string };

const aboutOf = (record: RunRecord | RunProgress): RunAbout => ({
    mode: record.run.mode,
    ...(record.from ? { from: record.from.label } : {}),
    startedAt: record.run.startedAt,
});

export const RunMarksContext = createContext<RunMarks | null>(null);

/** Run from here: a test run of the component and what follows it (the page runs it) */
export const RunFromContext = createContext<(nodeId: string) => void>(() => {});

export const useRunMark = (nodeId: string) => {
    const marks = useContext(RunMarksContext);
    const runFrom = useContext(RunFromContext);
    return marks
        ? {
              running: marks.running,
              run: marks.byNode.get(nodeId),
              full: marks.full?.get(nodeId),
              about: marks.about,
              fullAbout: marks.fullAbout,
              show: (port: string) => marks.onShow?.(nodeId, port),
              runFrom: () => runFrom(nodeId),
              iteration: marks.iterationOf(nodeId),
              pickIteration: (iteration: number) => marks.pickIteration?.(nodeId, iteration),
          }
        : null;
};

/** a Loop's iteration as the editor names it: its input envelope (1 the first) and its $_loopIndex */
export const iterationLabel = ({ envelope, index }: IterationOf) => `envelope ${envelope} · $_loopIndex ${index}`;

/**
 * The component runs the canvas shows: the run's and, in each Loop's region, those of the iteration picked for it
 * (the first if none is, or if the one picked was not kept), down nested Loops. A loop region's components are only
 * in its iterations' records; their Iteration start and Iteration end are the Loop's ports (its two cards), not components.
 */
export function shownComponents(components: ComponentRun[], iterationOf: (loopId: string) => number): Map<string, ComponentRun> {
    const byNode = new Map<string, ComponentRun>();
    const add = (list: ComponentRun[], inIteration: boolean) => {
        for (const c of list) {
            if (inIteration && (c.type === START || c.type === END)) {
                continue;
            }
            byNode.set(c.nodeId, c);
            const iterations = c.type === LOOP ? (c.subRuns ?? []) : [];
            const shown = iterations[iterationOf(c.nodeId)] ?? iterations[0];
            if (shown?.record) {
                add(shown.record.components, true);
            }
        }
    };
    add(components, false);
    return byNode;
}

/**
 * while it runs, the run so far (each component running or how it ended); then the record. The full run is the run's
 * components only (none inside a Loop): Run from here is not offered inside a loop region.
 */
export const runMarks = (
    record: RunRecord | RunProgress | null,
    running: boolean,
    onShow?: RunMarks['onShow'],
    full?: RunRecord | null,
    iterations?: { of: (loopId: string) => number; pick: (loopId: string, iteration: number) => void },
): RunMarks | null =>
    record || running
        ? {
              running,
              byNode: shownComponents(record?.components ?? [], iterations?.of ?? (() => 0)),
              iterationOf: iterations?.of ?? (() => 0),
              pickIteration: iterations?.pick,
              onShow,
              full: full ? new Map(full.components.map(c => [c.nodeId, c])) : undefined,
              ...(record ? { about: aboutOf(record) } : {}),
              ...(full ? { fullAbout: aboutOf(full) } : {}),
          }
        : null;

/**
 * What a pin keeps: the envelopes that went out of the component in the last run, per port, as the run's Data tab
 * shows them (the run keeps the first ones of each port, credentials and secrets hidden): the core's pinnedFromRun, the
 * same the MCP's pin_from_run takes.
 */
export const pinnedOutput = (run: ComponentRun | undefined): Record<string, EnvelopeData[]> | undefined => {
    if (!run) {
        return undefined;
    }
    const pin = pinnedFromRun(run);
    return pin.ok ? pin.pinned : structuredClone(run.outputSample);
};

const sum = (ports: Record<string, number> | undefined) => Object.values(ports ?? {}).reduce((n, v) => n + v, 0);

/**
 * What a component's run lets it offer (after a run only): Pin output needs something that went out of it, Run from
 * here something that came in. A component already pinned keeps Pin, to unpin it.
 */
export const runActions = (run: ComponentRun | undefined, pinned: boolean) => ({
    pin: pinned || sum(run?.outputs) > 0,
    runFromHere: sum(run?.inputs) > 0,
});
