import { expect, test } from 'bun:test';
import { flowRunner, type ExecutableFlow } from '@flowtinus/core';
import { evaluate } from '#shared/runner/evaluate';
import { runSummary } from '#features/mcp/run-summary';
import type { RunView } from '#features/runs/get-run/get-run-handler';

/** Start → a Log of level error → End, as a test run */
const flow: ExecutableFlow = {
    project: 'Test',
    flow: 'Logger',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: {} },
        { id: 'log', type: 'log', label: 'Log error', config: { level: 'error', message: "'something to look at'" } },
        {
            id: 'fails',
            type: 'mapper',
            label: 'Fails',
            config: { onError: 'continue', fields: [{ target: 'x', value: '$a.b', expression: true }] },
        },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'log', targetPort: 'in-0' },
        { source: 'log', sourcePort: 'out-0', target: 'fails', targetPort: 'in-0' },
        { source: 'fails', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
};

test("test_run's summary: what a component logged at level error is one of its logs, not an error; an envelope's error is", async () => {
    const record = await flowRunner(flow, { mode: 'validation', id: 'r1', evaluate });
    const summary = runSummary({ id: 'r1', flowId: 'f1', mode: 'validation', status: record.status, record } as unknown as RunView, 1);
    const log = summary.components.find(c => c.nodeId === 'log')!;
    expect(log).toMatchObject({ status: 'with-warnings', errors: 0, logs: ['error: something to look at'] });
    expect(log.errorMessages).toBeUndefined();
    const fails = summary.components.find(c => c.nodeId === 'fails')!;
    expect(fails.status).toBe('with-errors');
    expect(fails.errors).toBe(1);
    expect(fails.errorMessages?.[0]).toContain('$a.b');
});
