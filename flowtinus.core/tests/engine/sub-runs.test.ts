import { expect, test } from 'bun:test';
import { flowRunner } from '../../src/index';
import type { ExecutableFlow, ExecutableNode } from '../../src/index';
import { evaluate } from '../helpers';

const edge = (source: string, target: string, sourcePort = 'out-0', targetPort = 'in-0') => ({ source, sourcePort, target, targetPort });

const fetching = (more: Partial<ExecutableNode> = {}): ExecutableNode => ({
    id: 'fetch',
    type: 'http-request',
    label: 'Fetch',
    outputKey: 'response',
    config: { method: 'GET', url: { value: '`https://api.test/${$name}`', expression: true } },
    ...more,
});

const flow = (name: string, nodes: ExecutableNode[], edges: ExecutableFlow['edges']): ExecutableFlow => ({
    project: 'Test',
    flow: name,
    parameters: [],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: { acceptsInput: true } },
        ...nodes,
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges,
});

const subRuns: { kind: string; wf: ExecutableFlow; flows: Record<string, ExecutableFlow> }[] = [
    {
        kind: 'a Loop iteration',
        wf: flow(
            'Loop',
            [{ id: 'loop', type: 'loop', label: 'Loop', config: { maxIterations: 3 } }, fetching({ loop: 'loop' })],
            [
                edge('start', 'loop'),
                edge('loop', 'end'),
                edge('loop', 'fetch', 'iteration-start'),
                edge('fetch', 'loop', 'out-0', 'iteration-end'),
            ],
        ),
        flows: {},
    },
    {
        kind: 'a Wait call',
        wf: flow(
            'Caller',
            [{ id: 'call', type: 'flow', label: 'Call', config: { flowId: 'child', sendEnvelope: true } }],
            [edge('start', 'call'), edge('call', 'end')],
        ),
        flows: { child: flow('Child', [fetching()], [edge('start', 'fetch'), edge('fetch', 'end')]) },
    },
];

function hangingServer(onRequest = () => {}) {
    const server = {
        urls: [] as string[],
        aborted: [] as string[],
        send: async ({ url, signal }: { url: string; signal?: AbortSignal }) => {
            server.urls.push(url);
            onRequest();
            return new Promise<never>((_, reject) => {
                const abort = () => {
                    server.aborted.push(url);
                    reject(new Error('aborted'));
                };
                if (signal!.aborted) {
                    abort();
                } else {
                    signal!.addEventListener('abort', abort);
                }
            });
        },
    };
    return server;
}

const endings = [
    {
        ending: 'Stop',
        error: 'Run cancelled.',
        start: () => {
            const stop = new AbortController();
            setTimeout(() => stop.abort(), 50);
            return { server: hangingServer(), options: { signal: stop.signal } };
        },
    },
    { ending: 'the timeout', error: 'exceeded the maximum time', start: () => ({ server: hangingServer(), options: { timeoutMs: 50 } }) },
    {
        ending: 'Stop as the request starts',
        error: 'Run cancelled.',
        start: () => {
            const stop = new AbortController();
            return { server: hangingServer(() => stop.abort()), options: { signal: stop.signal } };
        },
    },
];

test.each(subRuns.flatMap(subRun => endings.map(ending => ({ ...subRun, ...ending }))))(
    '$ending cuts $kind short, and nothing goes on after the run has returned',
    async ({ wf, flows, error, start }) => {
        const { server, options } = start();
        const record = await flowRunner(wf, {
            mode: 'execution',
            id: 'r',
            evaluate,
            flows,
            input: [{ name: 'A' }],
            http: server.send,
            ...options,
        });
        expect(record.status).toBe('failed');
        expect(record.error).toContain(error);
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(server.urls).toEqual(['https://api.test/A']);
        expect(server.aborted).toEqual(server.urls);
    },
);
