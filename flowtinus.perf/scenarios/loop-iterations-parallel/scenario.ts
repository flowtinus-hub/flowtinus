import type { Scenario } from '#perf/scenario';
import { DATA_VERSION, LOOPS, loopStates } from '#scenarios/loop-iterations/data';

/*
 * loop-iterations' input, with the Loop's Parallel on and an iteration that waits 5 ms (a TypeScript step, as a page
 * query would): the run takes about size / 10 × 5 ms when 10 loops really run at once. Parallel no longer running the
 * loops side by side shows as a run ten times longer; what goes past that ideal, and the CPU, is the cost of running them
 * at once. All in memory (a timer, not the fake API), so no service and no network noise.
 */
const scenario: Scenario = {
    id: 'loop-iterations-parallel',
    description: `Start with input → Loop with Parallel on (${LOOPS} envelopes, 10 loops at once; inside: TypeScript that waits 5 ms → Mapper → Iteration end and Continue with) → End: running loops side by side while each iteration waits (about size / 10 × 5 ms).`,
    services: [],
    size: 2_000,
    quickSize: 200,
    seed: 1,
    timeoutMs: 120_000,
    dataVersion: DATA_VERSION,
    throughputNode: 'Loop',
    rulers: [
        { metric: 'durationMs', direction: 'lower-is-better' },
        { metric: 'envelopesPerSecond', direction: 'higher-is-better' },
        { metric: 'cpuMs', direction: 'lower-is-better' },
        { metric: 'memoryDeltaBytes', direction: 'lower-is-better' },
    ],
    load: async () => undefined,
    reset: async () => undefined,
    input: loopStates,
};

export default scenario;
