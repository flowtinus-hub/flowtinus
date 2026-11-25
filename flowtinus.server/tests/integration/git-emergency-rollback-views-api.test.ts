import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { API_SCOPES, insertApiToken, newApiToken } from '#features/api-tokens/api-tokens';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

const TOPOLOGY = `environments:
  - env: DEV
    label: Development
    branch: dev
    promotesTo: [QA]
    mode: direct
  - env: QA
    label: Quality
    branch: qa
    mode: pull-request
`;

describe('the emergency rollback where it shows: the flow list, the Environments page, "draft differs" and the MCP', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    // Orders deployed twice (labels One, Two), QA's branch at DEV's tip, then rolled back to v1: v2 is git's
    async function rolledBack() {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const call = async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        commitFiles(repo, 'flowtinus/config', { 'topology.yaml': TOPOLOGY }, 'DEV and QA');
        const orders = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
        const deployAs = async (label: string) => {
            const { flow, revision } = (await call('GET', `/flows/${orders}/draft`)).body;
            const nodes = flow.nodes.map((n: { type: string }) => (n.type === 'start' ? { ...n, label } : n));
            expect((await call('PUT', `/flows/${orders}/draft`, { revision, flow: { ...flow, nodes } })).status).toBe(200);
            const deployed = await call('POST', `/flows/${orders}/deploy`);
            expect(deployed.status).toBe(200);
            return deployed.body.versions[0] as { id: string; number: number };
        };
        const v1 = await deployAs('One');
        await deployAs('Two');
        git(repo, 'update-ref', 'refs/heads/qa', git(repo, 'rev-parse', 'dev'));
        expect((await call('POST', `/flows/${orders}/versions/${v1.id}/emergency-rollback`)).status).toBe(200);
        return { call, projectId, orders };
    }

    const mcpCall = async () => {
        const { token } = newApiToken();
        await insertApiToken(db, { userId: ANA, name: 'test', token, scopes: API_SCOPES });
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
                fetch: (url, init) => Promise.resolve(app.request(String(url), init as RequestInit)),
            }),
        );
        return async (name: string, args: Record<string, unknown>) => {
            const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
            return JSON.parse(result.content[0]!.text);
        };
    };

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-emergency-rollback-views-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('the flow list marks the row with the version that runs and git’s', async () => {
        const { call, projectId, orders } = await rolledBack();

        const [row] = (await call('GET', `/projects/${projectId}/contents`)).body.flows;
        expect(row).toMatchObject({
            id: orders,
            deployedVersion: 1,
            emergencyRollback: { number: 1, gitNumber: 2, by: ANA, byName: 'Ana' },
        });
    });

    test("the Environments page: a count on this environment's card; this server's column reads the version that runs, marked", async () => {
        const { call, orders } = await rolledBack();

        const page = (await call('GET', '/git/environments')).body;
        expect(page.pipeline.map((c: { env: string; emergencyRollbacks?: number }) => [c.env, c.emergencyRollbacks])).toEqual([
            ['DEV', 1],
            ['QA', undefined],
        ]);
        expect(page.runsWhere.flows).toEqual([
            {
                id: orders,
                name: 'Sales/Orders',
                cells: {
                    DEV: { state: 'deployed', content: null, differs: false, emergencyRollback: { number: 1, gitNumber: 2 } },
                    QA: { state: 'deployed', content: 'other', differs: true },
                },
            },
        ]);
    });

    test("the draft differs from git's version, not from the one that runs", async () => {
        const { call, orders } = await rolledBack();

        const deploy = await call('POST', `/flows/${orders}/deploy`);
        expect(deploy.status).toBe(400);
        expect(deploy.body.error.message).toBe('Nothing to commit: the draft is v2.');
    });

    test("the MCP reports the state: the version that runs, git's, by and when; the draft compared with git's", async () => {
        const { projectId, orders } = await rolledBack();
        const mcp = await mcpCall();

        const deployments = await mcp('get_deployments', { flowId: orders });
        expect(deployments).toMatchObject({
            deployedVersion: 1,
            draftDiffersFromDeployed: false,
            emergencyRollback: { runningVersion: 1, gitVersion: 2, by: 'Ana' },
        });
        expect(deployments.changes.changed).toEqual([]);
        expect(typeof deployments.emergencyRollback.at).toBe('string');

        const [flow] = (await mcp('get_project_contents', { projectId })).flows;
        expect(flow).toMatchObject({ deployedVersion: 1, emergencyRollback: { runningVersion: 1, gitVersion: 2, by: 'Ana' } });
    });
});
