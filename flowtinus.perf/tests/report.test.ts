import { describe, expect, test } from 'bun:test';
import { noise } from '#perf/report';
import type { ResultLine } from '#perf/results';

const execution = (durationMs: number, partial = false) =>
    ({
        partial,
        samples: [],
        rulers: [{ metric: 'durationMs', direction: 'lower-is-better', median: durationMs }],
    }) as unknown as ResultLine;

describe('the terminal report', () => {
    test('noise is the spread of the engine time over the last 3 executions, as the report page says it', () => {
        expect(noise([execution(100)])).toBeUndefined();
        expect(noise([execution(90), execution(100), execution(110)])).toBeCloseTo(0.2);
        expect(noise([execution(500), execution(90), execution(100), execution(110)])).toBeCloseTo(0.2);
        expect(noise([execution(90), execution(300, true), execution(110)])).toBeCloseTo(0.2);
    });
});
