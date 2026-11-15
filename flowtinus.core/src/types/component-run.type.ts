import type { LogLine } from '#types/log-line.type';
import type { RunStatus } from '#types/run-status.type';
import type { EnvelopeData } from '#types/envelope-data.type';
import type { RunProgress, RunRecord } from '#types/run-record.type';
import type { WriteCounts } from '#types/write-counts.type';

/** One iteration of a Loop: the input envelope whose loop it is (1 the first) and its loop index ($_loopIndex). */
export type IterationOf = { envelope: number; index: number };

/**
 * One run of a flow the component called (Flow Invoker): how it went and its record (what its components did: counts,
 * times, logs, and up to SUB_RUN_SAMPLE_SIZE envelopes per port), as it goes while it runs. A record only for the
 * first MAX_SUB_RUNS calls. `fireAndForget`: the caller did not wait for it; in a real run it was queued as a run of its
 * own (status `queued`, no record here: it has its own, under its id). `envelopes`: how many it took (a batch).
 * `parameters`: the Start parameters the call sent (secret values hidden; the others took their default).
 * A Loop's sub-runs are its iterations (the first MAX_SUB_RUNS): `iteration` says which, by the input envelope whose
 * loop it is (1 the first) and its loop index ($_loopIndex); `flow` is the Loop's label.
 */
export type SubRun = {
    id: string;
    flow: string;
    iteration?: IterationOf;
    status: RunStatus | 'running' | 'queued';
    durationMs: number;
    error?: string;
    record?: RunRecord | RunProgress;
    fireAndForget?: true;
    envelopes?: number;
    parameters?: Record<string, string>;
};

export type ComponentRun = {
    nodeId: string;
    label: string;
    type: string;
    status: 'not-run' | 'running' | 'completed' | 'disabled' | 'pinned' | 'skipped' | 'with-warnings' | 'with-errors' | 'failed';
    start?: string;
    end?: string;
    durationMs?: number;
    /**
     * Time the component spent processing, not counting the wait for envelopes nor for the next component.
     * Since everything runs on a single thread, it is practically its CPU: one component's time is never also counted for
     * another, so the components' active times add up to no more than the run. What a script awaits counts as Waiting
     * when it goes through the engine's wait (the server's runner does that for its fetch and timers), and is not active.
     */
    activeTimeMs?: number;
    /**
     * Time waiting for an outside system: rows coming from a database, a write to MongoDB, the envelopes of a called
     * flow. Not counted: waiting for envelopes, or for the next component to take them (backpressure).
     */
    waitingMs?: number;
    subRuns?: SubRun[];
    writes?: Record<string, WriteCounts>;
    memory?: { peakEnvelopes: number; peakBytes: number };
    inputs: Record<string, number>;
    outputs: Record<string, number>;
    logs: LogLine[];
    inputSample: EnvelopeData[];
    inputSampleByPort?: Record<string, EnvelopeData[]>;
    outputSample: Record<string, EnvelopeData[]>;
    /**
     * Envelopes of the samples above that this record does not have (input: inputSample and inputSampleByPort; output:
     * outputSample). In a run's progress: those too big to send while it goes (the final record has them); a run that
     * ended without its worker keeps its last progress, so its record may lack them too.
     */
    samplesNotKept?: { input: number; output: number };
};
