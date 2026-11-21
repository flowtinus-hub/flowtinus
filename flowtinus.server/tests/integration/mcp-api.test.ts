import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { insertMember, insertWorkspace, workspaceHandleOf } from '../helpers/workspaces';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDatabase, type Database } from '#shared/database/database';
import { API_SCOPES, insertApiToken, newApiToken, type ApiScope } from '#features/api-tokens/api-tokens';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

type Answer = { isError?: boolean; body: Record<string, any> };

/** a flow file: Start → a Filter → End, with a Data Grid as its source */
const flowYaml = (condition = '$n > 1') => `version: 1
name: Numbers
nodes:
  - { id: start, type: start, position: { x: 0, y: 0 }, config: {} }
  - id: grid
    type: datagrid
    position: { x: 300, y: 0 }
    config:
      columns: [{ name: n, type: number }]
      rows: [['1'], ['2'], ['3']]
  - { id: big, type: filter, position: { x: 600, y: 0 }, config: { condition: '${condition}' } }
  - { id: end, type: end, position: { x: 900, y: 0 }, config: {} }
edges:
  - { source: start, sourcePort: out-0, target: grid, targetPort: in-0 }
  - { source: grid, sourcePort: out-0, target: big, targetPort: in-0 }
  - { source: big, sourcePort: out-0, target: end, targetPort: in-0 }
`;

describe('MCP (/mcp)', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    const workspaceId = crypto.randomUUID();
    const ws = workspaceHandleOf(workspaceId);
    let ana: string;

    /** an MCP client over HTTP (the app's fetch), with a token of these scopes */
    const connect = async (scopes: readonly ApiScope[] = API_SCOPES, userId = ana) => {
        const { token } = newApiToken();
        await insertApiToken(db, { userId, name: 'test', token, scopes });
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
                fetch: (url, init) => Promise.resolve(app.request(String(url), init as RequestInit)),
            }),
        );
        const call = async (name: string, args: Record<string, unknown> = {}): Promise<Answer> => {
            const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
            return { isError: result.isError, body: JSON.parse(result.content[0]!.text) };
        };
        return { client, call };
    };

    let mcp: Awaited<ReturnType<typeof connect>>;

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId, 'Org');
        ana = await insertMember(db, workspaceId);
        app = createApp(db, 'DEV', undefined, undefined, { editorUrl: 'http://localhost:5180/', pollMs: 20, maxWaitS: 2 });
        mcp = await connect();
    });
    afterAll(() => db.close());

    test('without a token: 401, before any MCP', async () => {
        const response = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain('Bearer');
    });

    test('it lists its tools, resources and prompts; never a deploy', async () => {
        const tools = (await mcp.client.listTools()).tools.map(t => t.name);
        expect(tools).toEqual(
            expect.arrayContaining([
                'list_components',
                'describe_component',
                'validate_flow',
                'get_flow',
                'save_draft',
                'test_run',
                'run_for_real',
                'archive_flow',
                'get_run',
                'get_run_output',
                'list_runs',
                'pin_from_run',
                'unpin',
                'set_variable',
                'test_connection',
                'resolve_url',
                'create_project',
                'create_flow',
                'list_workspaces',
                'create_workspace',
            ]),
        );
        expect(tools.some(t => t.includes('deploy') && t !== 'get_deployments')).toBe(false);
        expect((await mcp.client.listPrompts()).prompts.map(p => p.name)).toEqual(['build-flow', 'debug-run']);
        const resources = (await mcp.client.listResources()).resources.map(r => r.uri);
        expect(resources).toContain('flowtinus://catalog');
        expect(resources).toContain('flowtinus://components/filter');
        const catalog = await mcp.client.readResource({ uri: 'flowtinus://catalog' });
        expect(JSON.parse((catalog.contents[0] as { text: string }).text).components.length).toBeGreaterThan(10);
    });

    test('the catalog: components, one in full, the flow format', async () => {
        const list = await mcp.call('list_components');
        expect(list.body.components.find((c: { type: string }) => c.type === 'filter').label).toBe('Filter');
        const filter = await mcp.call('describe_component', { type: 'filter' });
        expect(filter.body.settings[0].key).toBe('condition');
        expect(filter.body.commonSettings[0].key).toBe('onError');
        expect((await mcp.call('describe_component', { type: 'nope' })).isError).toBe(true);
        const format = (await mcp.call('get_flow_format')).body;
        expect(format.rules.length).toBeGreaterThan(5);
        // the patterns an agent needs before concluding a component cannot do something (the barrier, the checkpoint)
        expect(format.patterns.map((p: { name: string }) => p.name).join(' | ')).toContain('barrier');
    });

    let projectId: string;
    let flowId: string;

    test('its workspaces; create a project in one and a folder; list them', async () => {
        expect((await mcp.call('list_workspaces')).body).toEqual([
            { workspace: ws, name: 'Org', role: 'admin', editorUrl: `http://localhost:5180/w/${ws}/projects` },
        ]);
        // without the workspace: refused by the tool's input
        expect(
            ((await mcp.client.callTool({ name: 'create_project', arguments: { name: 'Agents' } })) as { isError?: boolean }).isError,
        ).toBe(true);
        expect((await mcp.call('create_project', { workspace: 'not-mine', name: 'Agents' })).body.error).toEqual({
            code: 'not-found',
            message: 'Workspace not found in your workspaces (list_workspaces gives them).',
        });
        const project = await mcp.call('create_project', { workspace: ws, name: 'Agents', description: 'made by an agent' });
        expect(project.isError).toBeFalsy();
        projectId = project.body.projectId;
        expect(project.body.editorUrl).toBe(`http://localhost:5180/w/${ws}/projects/${projectId}/flows`);
        const folder = await mcp.call('create_folder', { projectId, name: 'Imports' });
        expect(folder.body.folderId).toBeString();
        const projects = await mcp.call('list_projects', { workspace: ws });
        expect(projects.body.find((p: { name: string }) => p.name === 'Agents')).toMatchObject({ handle: 'agents' });
    });

    test('validate_flow: every issue with its node and setting; a valid one is ok', async () => {
        const bad = await mcp.call('validate_flow', { projectId, yaml: flowYaml('$n >') });
        expect(bad.body.ok).toBe(false);
        expect(bad.body.issues[0]).toMatchObject({ nodeId: 'big', settingKey: 'condition' });
        const broken = await mcp.call('validate_flow', { projectId, yaml: 'nodes: [' });
        expect(broken.body.issues[0].message).toStartWith('Not valid YAML');
        const good = await mcp.call('validate_flow', { projectId, yaml: flowYaml() });
        expect(good.body).toEqual({ ok: true, issues: [], warnings: [] });
        // the project: a Flow Invoker to a flow that is not there, a connection that is not there
        const refs = flowYaml().replace(
            '  - { id: end, type: end',
            `  - { id: call, type: flow, position: { x: 600, y: 200 }, config: { flowId: '${crypto.randomUUID()}' } }\n  - { id: end, type: end`,
        );
        const missing = await mcp.call('validate_flow', { projectId, yaml: refs });
        expect(missing.body.issues).toContainEqual(expect.objectContaining({ nodeId: 'call', settingKey: 'flowId' }));
    });

    /** the flow file with an HTTP Request before the End: by a profile's id, or by the name an expression gives */
    const withHttp = (connection: string, connectionName?: string) =>
        flowYaml()
            .replace('config: {} }\n  - id: grid', 'config: { parameters: [{ name: env, type: text, default: dev }] } }\n  - id: grid')
            .replace(
                '  - { id: end, type: end',
                `  - id: send\n    type: http-request\n    position: { x: 900, y: 200 }\n    config:\n      connection: '${connection}'\n${connectionName ? `      connectionName: { value: "${connectionName}", expression: true }\n` : ''}      method: GET\n      url: { value: 'https://api.example.com/x', expression: false }\n  - { id: end, type: end`,
            )
            .concat(
                '  - { source: big, sourcePort: out-0, target: send, targetPort: in-0 }\n  - { source: send, sourcePort: out-0, target: end, targetPort: in-0 }\n',
            );

    test('a connection or secret the workspace does not have yet is a warning: the draft is saved', async () => {
        const byId = await mcp.call('validate_flow', { projectId, yaml: withHttp('not-created-yet') });
        expect(byId.body.ok).toBe(true);
        expect(byId.body.warnings).toContainEqual({
            nodeId: 'send',
            settingKey: 'connection',
            message: expect.stringContaining('which is not a connection of this workspace yet (list_connections lists them)'),
        });
        expect(JSON.stringify(byId.body)).not.toContain('of this project');
        // in a project of its own: the next tests count the flows of the other
        const pending = (await mcp.call('create_project', { workspace: ws, name: 'Pending connections' })).body.projectId;
        const created = await mcp.call('create_flow', {
            projectId: pending,
            name: 'Pending connection',
            yaml: withHttp('not-created-yet'),
        });
        expect(created.isError).toBeFalsy();
        expect(created.body.warnings).toContainEqual(expect.objectContaining({ nodeId: 'send', settingKey: 'connection' }));
    });

    test('a dynamic connection name known before the run (parameters, variables) is checked against the workspace', async () => {
        const name = "'API_' + $PARAMETERS.env";
        const missing = await mcp.call('validate_flow', { projectId, yaml: withHttp('$dynamic', name) });
        expect(missing.body.ok).toBe(true);
        expect(missing.body.warnings).toContainEqual({
            nodeId: 'send',
            settingKey: 'connectionName',
            message: expect.stringContaining('"API_dev" (with the Start\'s defaults), which is not a connection of this workspace yet'),
        });
        // one with that name (whatever the case): no warning
        const profileId = crypto.randomUUID();
        await db.query(
            `INSERT INTO connections (id, workspace_id, name, type, config) VALUES ($1, $2, 'api_DEV', 'http-client', '{}'::jsonb)`,
            [profileId, workspaceId],
        );
        const found = await mcp.call('validate_flow', { projectId, yaml: withHttp('$dynamic', name) });
        await db.query('DELETE FROM connections WHERE id = $1', [profileId]);
        expect(found.body.warnings.filter((w: { nodeId?: string }) => w.nodeId === 'send')).toEqual([]);
        // a name read from the envelope is only known in the run: nothing to check
        const fromEnvelope = await mcp.call('validate_flow', { projectId, yaml: withHttp('$dynamic', "'API_' + $env") });
        expect(fromEnvelope.body.warnings.filter((w: { nodeId?: string }) => w.nodeId === 'send')).toEqual([]);
    });

    test('create_flow with yaml: refused when not valid (nothing created), saved when it is', async () => {
        const refused = await mcp.call('create_flow', { projectId, name: 'Numbers', yaml: flowYaml('') });
        expect(refused.isError).toBe(true);
        expect(refused.body.error.issues.length).toBeGreaterThan(0);
        expect((await mcp.call('get_project_contents', { projectId })).body.flows).toEqual([]);

        const created = await mcp.call('create_flow', { projectId, name: 'Numbers', yaml: flowYaml() });
        expect(created.isError).toBeFalsy();
        flowId = created.body.flowId;
        expect(created.body.revision).toBe(1);
        const flows = (await mcp.call('get_project_contents', { projectId })).body.flows;
        expect(flows.map((f: { name: string }) => f.name)).toEqual(['Numbers']);
    });

    test('get_flow and save_draft: the revision guards a person’s change', async () => {
        const flow = await mcp.call('get_flow', { flowId });
        expect(flow.body.revision).toBe(1);
        expect(flow.body.yaml).toContain('type: filter');

        const stale = await mcp.call('save_draft', { flowId, yaml: flowYaml('$n > 2'), expectedRevision: 0 });
        expect(stale.body.error).toMatchObject({ code: 'conflict', currentRevision: 1 });

        const invalid = await mcp.call('save_draft', { flowId, yaml: flowYaml(''), expectedRevision: 1 });
        expect(invalid.body.error.code).toBe('validation');

        const saved = await mcp.call('save_draft', { flowId, yaml: flowYaml('$n > 2'), expectedRevision: 1 });
        expect(saved.body.revision).toBe(2);
        expect((await mcp.call('get_flow', { flowId })).body.yaml).toContain('$n > 2');
    });

    test('resolve_url: a flow, a project, a run, and what is not a Flowtinus link', async () => {
        expect(
            (await mcp.call('resolve_url', { url: `https://any.host:9999/w/${ws}/projects/${projectId}/flows/${flowId}` })).body,
        ).toMatchObject({
            kind: 'flow',
            workspace: ws,
            projectId,
            flowId,
            flowName: 'Numbers',
        });
        expect((await mcp.call('resolve_url', { url: `/w/${ws}/projects/${projectId}/scripts` })).body).toMatchObject({
            kind: 'project',
            projectName: 'Agents',
        });
        expect((await mcp.call('resolve_url', { url: `/w/${ws}/projects/${crypto.randomUUID()}/flows/${flowId}` })).body.error).toContain(
            'not found',
        );
        expect((await mcp.call('resolve_url', { url: `/w/${ws}/secrets` })).body).toEqual({ kind: 'workspace', workspace: ws });
        expect((await mcp.call('resolve_url', { url: `/w/someone-elses/projects` })).body.error).toContain('not found');
        expect((await mcp.call('resolve_url', { url: 'https://example.com/whatever' })).body.error).toContain('Not a Flowtinus link');
    });

    test('test_run: no live supervisor for the tag is said as it is; then queued, followed, summarized', async () => {
        const none = await mcp.call('test_run', { flowId, timeoutS: 0 });
        expect(none.body.error.code).toBe('unavailable');

        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('mcp-1', '{default}', 1, 'box')`);
        const queued = await mcp.call('test_run', { flowId, timeoutS: 0 });
        expect(queued.body).toMatchObject({ status: 'queued', mode: 'validation', components: [] });
        const runId = queued.body.runId;

        // a supervisor ran it: its record
        const record = {
            run: { id: runId, mode: 'validation', workspace: 'w', project: 'Agents', flow: 'Numbers', startedAt: new Date().toISOString() },
            parameters: {},
            status: 'with-errors',
            end: new Date().toISOString(),
            durationMs: 12,
            components: [
                {
                    nodeId: 'grid',
                    label: 'Data Grid',
                    type: 'datagrid',
                    status: 'completed',
                    inputs: { 'in-0': 1 },
                    outputs: { 'out-0': 3 },
                    logs: [],
                    inputSample: [{}],
                    outputSample: { 'out-0': [{ n: 1 }, { n: 2 }, { n: 3 }] },
                },
                {
                    nodeId: 'big',
                    label: 'Filter',
                    type: 'filter',
                    status: 'with-errors',
                    inputs: { 'in-0': 3 },
                    outputs: { 'out-0': 1, 'out-1': 1 },
                    logs: [{ at: new Date().toISOString(), level: 'error', message: 'x is not defined' }],
                    inputSample: [],
                    outputSample: { 'out-0': [{ n: 3, big: 'x'.repeat(20_000) }] },
                },
            ],
        };
        await db.query(`UPDATE test_runs SET status = 'with-errors', record = $2::text::jsonb, finished_at = now() WHERE id = $1`, [
            runId,
            JSON.stringify(record),
        ]);
        const run = await mcp.call('get_run', { runId, sample: 2 });
        expect(run.body.status).toBe('with-errors');
        expect(run.body.editorUrl).toBe(`http://localhost:5180/runs/${runId}`);
        const [grid, big] = run.body.components;
        expect(grid).toMatchObject({
            nodeId: 'grid',
            in: { 'in-0': 1 },
            out: { 'out-0': 3 },
            errors: 0,
            sample: { 'out-0': [{ n: 1 }, { n: 2 }] },
        });
        expect(big).toMatchObject({ errors: 1, errorMessages: ['x is not defined'] });
        // too large for the summary: shrunk, still valid JSON (the long text cut and marked)
        expect(big.shrunk).toBe(1);
        expect(big.sample['out-0'][0]).toEqual({ n: 3, big: `${'x'.repeat(2000)}…+18000 chars` });
        expect((await mcp.call('resolve_url', { url: `/runs/${runId}` })).body).toMatchObject({
            kind: 'run',
            workspace: ws,
            flowId,
            projectId,
        });
    });

    test('test_run waits for its run until it ends', async () => {
        const answer = mcp.call('test_run', { flowId, timeoutS: 2 });
        // the run the call just queued, ended by "a supervisor" a moment later
        let runId: string | undefined;
        for (let i = 0; i < 100 && !runId; i++) {
            await Bun.sleep(10);
            [{ id: runId } = { id: undefined as unknown as string }] = await db.query<{ id: string }>(
                `SELECT id FROM test_runs WHERE flow_id = $1 AND status = 'queued'`,
                [flowId],
            );
        }
        await db.query(`UPDATE test_runs SET status = 'completed', record = $2::text::jsonb, finished_at = now() WHERE id = $1`, [
            runId,
            JSON.stringify({ status: 'completed', durationMs: 5, components: [] }),
        ]);
        expect((await answer).body).toMatchObject({ runId, status: 'completed', durationMs: 5 });
    });

    test('cancel_run: only the runs of the token’s user', async () => {
        const queued = await mcp.call('test_run', { flowId, timeoutS: 0 });
        const other = await connect(API_SCOPES, await insertMember(db, workspaceId, { name: 'Bruno' }));
        expect((await other.call('cancel_run', { runId: queued.body.runId })).body.error.code).toBe('forbidden');
        expect((await mcp.call('cancel_run', { runId: queued.body.runId })).body).toMatchObject({ status: 'cancelled' });
    });

    test("run_for_real: only with the scope runs:execute and the user's approval quoted; a run for real, kept with the history", async () => {
        const tool = (await mcp.client.listTools()).tools.find(t => t.name === 'run_for_real');
        expect(tool?.description).toContain('explicitly authorized');
        expect(tool?.description).toContain('standing approval');
        expect(tool?.annotations).toMatchObject({ destructiveHint: true });
        // userApproval is optional in the schema (a token with a run scope runs without it); the server requires it otherwise
        expect(tool?.inputSchema.required).toContain('flowId');
        expect(tool?.inputSchema.required).not.toContain('userApproval');

        // runs:test is not enough
        const tester = await connect(['runs:test', 'runs:read']);
        const denied = await tester.call('run_for_real', { flowId, userApproval: 'run it for real', timeoutS: 0 });
        expect(denied.body.error).toEqual({ code: 'forbidden', message: 'This token does not have the scope runs:execute.' });

        // without the user's words: refused, nothing queued
        const before = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM runs WHERE flow_id = $1', [flowId]);
        for (const args of [
            { flowId, timeoutS: 0 },
            { flowId, userApproval: '  ', timeoutS: 0 },
        ]) {
            const result = (await mcp.client.callTool({ name: 'run_for_real', arguments: args })) as { isError?: boolean };
            expect(result.isError).toBe(true);
        }
        expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM runs WHERE flow_id = $1', [flowId]))[0]!.n).toBe(
            before[0]!.n,
        );

        const queued = await mcp.call('run_for_real', { flowId, userApproval: 'run it for real', timeoutS: 0 });
        expect(queued.body).toMatchObject({ status: 'queued', mode: 'execution', userApproval: 'run it for real' });
        const [row] = await db.query<{ mode: string; started_by: string }>('SELECT mode, started_by FROM runs WHERE id = $1', [
            queued.body.runId,
        ]);
        expect(row).toEqual({ mode: 'execution', started_by: ana });
        expect((await mcp.call('cancel_run', { runId: queued.body.runId })).body).toMatchObject({ status: 'cancelled' });
    });

    test("archive_flow: only with the scope flows:archive and the user's approval quoted; one flow, then not found", async () => {
        const created = await mcp.call('create_flow', { projectId, name: 'To archive' });
        const target = created.body.flowId as string;
        const tool = (await mcp.client.listTools()).tools.find(t => t.name === 'archive_flow');
        expect(tool?.description).toContain('explicitly authorized');
        expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(['flowId', 'userApproval']));

        // flows:write is not enough
        const writer = await connect(['flows:read', 'flows:write']);
        const denied = await writer.call('archive_flow', { flowId: target, userApproval: 'you can archive it' });
        expect(denied.body.error).toEqual({ code: 'forbidden', message: 'This token does not have the scope flows:archive.' });

        // without the user's words: refused, still there
        const result = (await mcp.client.callTool({ name: 'archive_flow', arguments: { flowId: target } })) as { isError?: boolean };
        expect(result.isError).toBe(true);
        expect((await mcp.call('get_flow', { flowId: target })).isError).toBeFalsy();

        expect((await mcp.call('archive_flow', { flowId: target, userApproval: 'archive To archive' })).body).toEqual({
            flowId: target,
            name: 'To archive',
            archived: true,
            userApproval: 'archive To archive',
        });
        expect((await mcp.call('get_flow', { flowId: target })).body.error.code).toBe('not-found');
        expect((await mcp.call('archive_flow', { flowId: target, userApproval: 'archive To archive' })).body.error.code).toBe('not-found');
    });

    test('get_deployments: nothing deployed; get_flow_calls; the resources lists', async () => {
        expect((await mcp.call('get_deployments', { flowId })).body).toMatchObject({
            deployedVersion: null,
            draftDiffersFromDeployed: null,
        });
        expect((await mcp.call('get_flow_calls', { flowId })).body).toEqual({ calls: [], calledBy: [], cycles: [] });
        expect((await mcp.call('list_connections', { workspace: ws })).body).toEqual({ connections: [] });
        expect((await mcp.call('list_secret_names', { workspace: ws })).body).toEqual({ secrets: [] });
    });

    test('scripts: create, read, save over the revision; syntax checked first', async () => {
        const code = `export function total(price: number, qty: number): number {
    return price * qty;
}
`;
        const broken = await mcp.call('save_script', { projectId, path: 'pricing/tax', content: 'export function (' });
        expect(broken.body.error.message).toContain('does not compile');

        const created = await mcp.call('save_script', { projectId, path: 'pricing/tax', content: code });
        expect(created.body).toMatchObject({ path: 'pricing/tax', revision: 0, exports: [{ name: 'total', function: true }] });
        expect((await mcp.call('save_script', { projectId, path: 'pricing/tax', content: code })).body.error).toMatchObject({
            code: 'conflict',
            currentRevision: 0,
        });

        const read = await mcp.call('get_script', { projectId, path: 'pricing/tax' });
        expect(read.body).toMatchObject({ content: code, revision: 0, importPath: `@w/${ws}/agents/scripts/pricing/tax` });

        const saved = await mcp.call('save_script', {
            projectId,
            path: 'pricing/tax',
            content: code.replace('price * qty', 'price * qty * 1.1'),
            expectedRevision: 0,
        });
        expect(saved.body.revision).toBe(1);
        expect(
            (await mcp.call('save_script', { projectId, path: 'pricing/tax', content: code, expectedRevision: 0 })).body.error,
        ).toMatchObject({ code: 'conflict', currentRevision: 1 });
        expect((await mcp.call('list_scripts', { projectId })).body.scripts).toEqual([
            {
                path: 'pricing/tax',
                importPath: `@w/${ws}/agents/scripts/pricing/tax`,
                exports: [expect.objectContaining({ name: 'total' })],
            },
        ]);
    });

    test('a token without the scope: forbidden, naming it', async () => {
        const reader = await connect(['catalog:read']);
        expect((await reader.call('list_components')).isError).toBeFalsy();
        const denied = await reader.call('save_draft', { flowId, yaml: flowYaml(), expectedRevision: 0 });
        expect(denied.isError).toBe(true);
        expect(denied.body.error).toEqual({ code: 'forbidden', message: 'This token does not have the scope flows:write.' });
    });

    test("the token never does more than the user's role: a viewer's token with every scope reads, never writes or runs", async () => {
        const viewer = await connect(API_SCOPES, await insertMember(db, workspaceId, { name: 'Vi', role: 'viewer' }));
        const read = await viewer.call('get_flow', { flowId });
        expect(read.isError).toBeFalsy();
        const saved = await viewer.call('save_draft', { flowId, yaml: read.body.yaml, expectedRevision: read.body.revision });
        expect(saved.body.error).toEqual({ code: 'forbidden', message: 'Only an editor or an admin of this workspace can do this.' });
        expect((await viewer.call('test_run', { flowId, timeoutS: 0 })).body.error.code).toBe('forbidden');
        expect((await viewer.call('create_project', { workspace: ws, name: 'Theirs' })).body.error.code).toBe('forbidden');
    });

    test('create_workspace: with the scope workspaces:write, and only for an admin of the environment', async () => {
        const created = await mcp.call('create_workspace', { handle: 'agents-ws', name: 'Agents' });
        expect(created.body.error).toEqual({ code: 'forbidden', message: 'Only an admin of the environment can create workspaces.' });

        const envAdmin = await insertMember(db, workspaceId, { name: 'Root', isAdmin: true });
        const root = await connect(API_SCOPES, envAdmin);
        expect((await root.call('create_workspace', { handle: 'agents-ws', name: 'Agents' })).body).toEqual({
            workspace: 'agents-ws',
            editorUrl: 'http://localhost:5180/w/agents-ws/projects',
        });
        expect(
            (await root.call('list_workspaces')).body.map((w: { workspace: string; role: string }) => [w.workspace, w.role]),
        ).toContainEqual(['agents-ws', 'admin']);
        const narrow = await connect(['flows:read'], envAdmin);
        expect((await narrow.call('create_workspace', { handle: 'other-ws', name: 'Other' })).body.error.message).toBe(
            'This token does not have the scope workspaces:write.',
        );
    });

    test('a flow with a Loop: validate_flow refuses an open loop region; create_flow, get_flow and save_draft keep `loop`', async () => {
        const loopYaml = (extraEdge = '') => `version: 1
name: Pages
nodes:
  - { id: start, type: start, position: { x: 0, y: 0 }, config: {} }
  - { id: pages, type: loop, position: { x: 200, y: -100 }, size: { width: 480, height: 272 }, config: { maxIterations: 5, stopCondition: '$_loopIndex >= 3' } }
  - { id: page, type: mapper, loop: pages, position: { x: 360, y: 0 }, config: { fields: [{ target: page, value: $_loopIndex, expression: true }] } }
  - { id: end, type: end, position: { x: 800, y: 0 }, config: {} }
edges:
  - { source: start, sourcePort: out-0, target: pages, targetPort: in-0 }
  - { source: pages, sourcePort: iteration-start, target: page, targetPort: in-0 }
  - { source: page, sourcePort: out-0, target: pages, targetPort: iteration-end }
  - { source: pages, sourcePort: out-0, target: end, targetPort: in-0 }
${extraEdge}`;
        const open = await mcp.call('validate_flow', {
            projectId,
            yaml: loopYaml('  - { source: page, sourcePort: out-0, target: end, targetPort: in-0 }\n'),
        });
        expect(open.body.ok).toBe(false);
        expect(open.body.issues.map((i: { message: string }) => i.message).join(' ')).toContain('a loop region is closed');
        expect((await mcp.call('validate_flow', { projectId, yaml: loopYaml() })).body.ok).toBe(true);

        const project = await mcp.call('create_project', { workspace: ws, name: 'Loops' });
        const created = await mcp.call('create_flow', { projectId: project.body.projectId, name: 'Pages', yaml: loopYaml() });
        expect(created.isError).toBeFalsy();
        const flow = await mcp.call('get_flow', { flowId: created.body.flowId });
        expect(flow.body.yaml).toContain('loop: pages');
        const saved = await mcp.call('save_draft', {
            flowId: created.body.flowId,
            yaml: flow.body.yaml,
            expectedRevision: flow.body.revision,
        });
        expect(saved.isError).toBeFalsy();
    });

    test('another workspace’s flow is not found', async () => {
        const otherWorkspace = crypto.randomUUID();
        await insertWorkspace(db, otherWorkspace, 'Other');
        const eve = await insertMember(db, otherWorkspace, { name: 'Eve' });
        const { token } = newApiToken();
        await insertApiToken(db, { userId: eve, name: 'other', token, scopes: API_SCOPES });
        const client = new Client({ name: 'other', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
                fetch: (url, init) => Promise.resolve(app.request(String(url), init as RequestInit)),
            }),
        );
        const result = (await client.callTool({ name: 'get_flow', arguments: { flowId } })) as { content: { text: string }[] };
        expect(JSON.parse(result.content[0]!.text).error.code).toBe('not-found');
    });
});
