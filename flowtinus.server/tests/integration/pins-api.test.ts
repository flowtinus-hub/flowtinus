import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { MAX_PINNED_BYTES, type RunRecord } from '@flowtinus/core';
import { ANA, BIA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { followRunEvents } from '#features/runs/run-events';
import { API_SCOPES, insertApiToken, newApiToken } from '#features/api-tokens/api-tokens';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../../api/app';
import { Supervisor } from '../../supervisor/supervisor';
import { silentLogger } from '#shared/logging/logger';
import { inProcessExecutor } from '../../supervisor/workers/executor';

setDefaultTimeout(30_000);

describe('pins api', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let supervisor: Supervisor;
    let stopFollowing: () => Promise<void>;
    const workspaceId = crypto.randomUUID();

    const call = async (method: string, path: string, body?: unknown, user = ANA) => {
        const response = await app.request(wsPath(workspaceId, path), {
            method,
            headers: { 'x-user-id': user, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, any> };
    };

    const ended = async (id: unknown, user = ANA) => {
        for (;;) {
            const run = await call('GET', `/runs/${id}`, undefined, user);
            if (run.body.status !== 'queued' && run.body.status !== 'running') {
                return run.body.record as RunRecord;
            }

            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };

    const mcpAs = async (userId: string) => {
        const { token } = newApiToken();
        await insertApiToken(db, { userId, name: 'test', token, scopes: API_SCOPES });
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
                fetch: (url, init) => Promise.resolve(app.request(String(url), init as RequestInit)),
            }),
        );
        return async (name: string, args: Record<string, unknown> = {}) => {
            const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
            return { isError: result.isError, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
        };
    };

    const newFlow = async (name: string) => {
        const projectId = (await call('POST', '/projects', { name })).body.id as string;
        const flowId = (await call('POST', `/projects/${projectId}/flows`, { name, folderId: null })).body.id as string;
        const draft = (await call('GET', `/flows/${flowId}/draft`)).body as { flow: Record<string, unknown> };
        const saved = await call('PUT', `/flows/${flowId}/draft`, {
            revision: 0,
            flow: {
                ...draft.flow,
                nodes: [
                    { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
                    {
                        id: 'grid',
                        type: 'datagrid',
                        position: { x: 160, y: 0 },
                        config: { columns: [{ name: 'n', type: 'number' }], rows: [['1'], ['2'], ['3']] },
                    },
                    { id: 'end', type: 'end', position: { x: 320, y: 0 }, config: {} },
                ],
                edges: [
                    { source: 'start', sourcePort: 'out-0', target: 'grid', targetPort: 'in-0' },
                    { source: 'grid', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
                ],
            },
        });
        expect(saved.status).toBe(200);
        return flowId;
    };

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId, 'acme');
        const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(5) }]);
        app = createApp(db, 'DEV', keyring, undefined, { editorUrl: 'http://localhost:5180/', pollMs: 20, maxWaitS: 10 });
        stopFollowing = await followRunEvents(db);
        supervisor = new Supervisor({ db, keyring, executor: inProcessExecutor(), tags: ['default'], logger: silentLogger(), pollMs: 200 });
        await supervisor.start();
    });

    afterAll(async () => {
        await supervisor.stop();
        await stopFollowing();
        await db.close();
    });

    test("a pin is its user's: another user on the same flow sees none; the draft holds no pin", async () => {
        const flowId = await newFlow('Apart');
        const pinned = { 'out-0': [{ n: 9 }] };
        expect((await call('PUT', `/flows/${flowId}/pins/grid`, { pinned })).status).toBe(200);

        expect((await call('GET', `/flows/${flowId}/pins`)).body).toEqual({ pins: { grid: pinned } });
        expect((await call('GET', `/flows/${flowId}/pins`, undefined, BIA)).body).toEqual({ pins: {} });

        const draft = (await call('GET', `/flows/${flowId}/draft`)).body;
        const withPin = { ...draft.flow, nodes: draft.flow.nodes.map((n: { id: string }) => (n.id === 'grid' ? { ...n, pinned } : n)) };
        expect((await call('PUT', `/flows/${flowId}/draft`, { revision: draft.revision, flow: withPin })).status).toBe(200);
        const read = (await call('GET', `/flows/${flowId}/draft`)).body;
        expect(read.flow.nodes.find((n: { id: string }) => n.id === 'grid').pinned).toBeUndefined();
    });

    test("a test run replays the running user's pins, another user's test run runs the component, a run for real ignores them", async () => {
        const flowId = await newFlow('Replay');
        await call('PUT', `/flows/${flowId}/pins/grid`, { pinned: { 'out-0': [{ n: 9 }] } });
        const gridOf = async (mode: string, user: string) => {
            const record = await ended((await call('POST', `/flows/${flowId}/runs`, { mode }, user)).body.id, user);
            return record.components.find(c => c.nodeId === 'grid')!;
        };

        const ana = await gridOf('validation', ANA);
        expect(ana.status).toBe('pinned');
        expect(ana.outputSample['out-0']).toEqual([{ n: 9 }]);
        expect((await gridOf('validation', BIA)).status).not.toBe('pinned');
        expect((await gridOf('execution', ANA)).status).not.toBe('pinned');
    });

    test("unpin takes off only its user's pin", async () => {
        const flowId = await newFlow('Unpin');
        await call('PUT', `/flows/${flowId}/pins/grid`, { pinned: { 'out-0': [{ n: 1 }] } });
        await call('PUT', `/flows/${flowId}/pins/grid`, { pinned: { 'out-0': [{ n: 2 }] } }, BIA);

        expect((await call('DELETE', `/flows/${flowId}/pins/grid`)).body).toEqual({ unpinned: ['grid'] });
        expect((await call('GET', `/flows/${flowId}/pins`)).body).toEqual({ pins: {} });
        expect((await call('GET', `/flows/${flowId}/pins`, undefined, BIA)).body).toEqual({ pins: { grid: { 'out-0': [{ n: 2 }] } } });
    });

    test('the size limit holds per user and flow', async () => {
        const flowId = await newFlow('Big');
        const half = { 'out-0': [{ text: 'x'.repeat(MAX_PINNED_BYTES / 2) }] };
        expect((await call('PUT', `/flows/${flowId}/pins/grid`, { pinned: half })).status).toBe(200);
        expect((await call('PUT', `/flows/${flowId}/pins/end`, { pinned: half }, BIA)).status).toBe(200);

        const over = await call('PUT', `/flows/${flowId}/pins/end`, { pinned: half });
        expect(over.status).toBe(400);
        expect(over.body.error.message).toContain('unpin a component');
        expect((await call('PUT', `/flows/${flowId}/pins/grid`, { pinned: half })).status).toBe(200);
    });

    test("the MCP's pin_from_run, unpin and test_run act on the token's user's pins, the editor's too", async () => {
        const flowId = await newFlow('Agent');
        const ana = await mcpAs(ANA);
        const bia = await mcpAs(BIA);
        const ran = await ana('test_run', { flowId });
        expect(ran.body.status).toBe('completed');
        const before = (await ana('get_flow', { flowId })).body.revision;

        const pinned = await ana('pin_from_run', { flowId, nodeId: 'grid', runId: ran.body.runId, port: 'out-0' });
        expect(pinned.body).toMatchObject({ nodeId: 'grid', pinned: { 'out-0': 3 } });
        expect((await ana('get_flow', { flowId })).body).toMatchObject({ revision: before, pinnedNodes: ['grid'] });
        expect((await call('GET', `/flows/${flowId}/pins`)).body.pins.grid['out-0']).toHaveLength(3);
        expect((await bia('get_flow', { flowId })).body.pinnedNodes).toBeUndefined();
        expect((await ana('get_flow', { flowId, includePinned: true })).body.yaml).toContain('pinned');

        const flow = (await ana('get_flow', { flowId })).body;
        expect((await ana('save_draft', { flowId, yaml: flow.yaml, expectedRevision: flow.revision })).isError).toBeFalsy();
        expect((await ana('get_flow', { flowId })).body.pinnedNodes).toEqual(['grid']);

        await call('PUT', `/flows/${flowId}/pins/grid`, { pinned: { 'out-0': [{ n: 7 }] } });
        const replayed = await ana('test_run', { flowId });
        expect(replayed.body.output).toEqual([{ n: 7 }]);
        expect((await bia('test_run', { flowId })).body.outputCount).toBe(3);

        const unpinned = await ana('unpin', { flowId, nodeId: ['grid', 'end', 'nope'] });
        expect(unpinned.body).toMatchObject({ unpinned: ['grid'], notPinned: ['end'], notFound: ['nope'] });
        expect((await call('GET', `/flows/${flowId}/pins`)).body).toEqual({ pins: {} });
    });
});
