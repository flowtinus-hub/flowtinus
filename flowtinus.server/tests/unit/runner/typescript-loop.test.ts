import { expect, test } from 'bun:test';
import { flowRunner, type ExecutableFlow } from '@flowtinus/core';
import { evaluate } from '#shared/runner/evaluate';
import { prepareScript } from '#shared/runner/prepare-script';

const CODE = `let calls = 0;
async function process($input) {
  calls += 1;
  const run = $FLOW_CURRENT_RUN;
  await new Promise(resolve => setTimeout(resolve, (4 - $input.n) * 3));
  return { calls, sameRun: run === $FLOW_CURRENT_RUN };
}`;

const loopWithScript = (code: string, parallel: boolean): ExecutableFlow => ({
    project: 'P',
    flow: 'Loop',
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
        { id: 'loop', type: 'loop', label: 'Loop', config: { maxIterations: 100, stopCondition: '$_loopIndex >= 3', parallel } },
        { id: 'ts', type: 'typescript', label: 'Script', loop: 'loop', config: { code } },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'loop', targetPort: 'in-0' },
        { source: 'loop', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        { source: 'loop', sourcePort: 'iteration-start', target: 'ts', targetPort: 'in-0' },
        { source: 'ts', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
    ],
});

const run = async (parallel: boolean) => {
    const reached: { result: { calls: number; sameRun: boolean } }[] = [];
    const record = await flowRunner(loopWithScript(CODE, parallel), {
        mode: 'execution',
        id: 'r',
        evaluate,
        input: [{ n: 1 }, { n: 2 }, { n: 3 }],
        onReachEnd: async doc => void reached.push(doc.DATA as (typeof reached)[number]),
        prepareScript: (code, globals) => prepareScript(code, globals),
    });
    return { record, results: reached.map(d => d.result) };
};

test("a TypeScript step's top-level state starts fresh on every Loop iteration", async () => {
    const { record, results } = await run(false);
    expect(record.status).toBe('completed');
    expect(results.map(r => r.calls)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
});

test('parallel iterations each keep their own $FLOW_CURRENT_RUN while they await', async () => {
    const { record, results } = await run(true);
    expect(record.status).toBe('completed');
    expect(results).toEqual(Array.from({ length: 9 }, () => ({ calls: 1, sameRun: true })));
});
