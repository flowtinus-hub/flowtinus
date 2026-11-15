import type { Scenario } from '#perf/scenario';
import { DATA_VERSION, loopStates } from './data';

const scenario: Scenario = {
    id: 'loop-iterations',
    description:
        'Start with input → Loop (one loop per envelope, one after another; inside: Mapper → Iteration end and Continue with) → End: the cost of one iteration (a fresh inner flow, a copy of the loop state, the stop condition).',
    services: [],
    size: 20_000,
    quickSize: 2_000,
    seed: 1,
    timeoutMs: 180_000,
    dataVersion: DATA_VERSION,
    throughputNode: 'Loop',
    rulers: [
        { metric: 'durationMs', direction: 'lower-is-better' },
        { metric: 'envelopesPerSecond', direction: 'higher-is-better' },
        { metric: 'memoryDeltaBytes', direction: 'lower-is-better' },
        { metric: 'recordBytes', direction: 'lower-is-better' },
    ],
    load: async () => undefined,
    reset: async () => undefined,
    input: loopStates,
};

export default scenario;
