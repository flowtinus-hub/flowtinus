import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { ANA, insertMember, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

type Node = { id: string; type: string; position: { x: number; y: number }; config: Record<string, unknown> };

/** Moving a project to another workspace: what its flows use must be there; the drafts follow; the deployed are undeployed. */
describe('move a project to another workspace', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    const from = crypto.randomUUID();
    const to = crypto.randomUUID();

    const call = async (workspace: string, method: string, path: string, body?: unknown, user = ANA) => {
        const response = await app.request(wsPath(workspace, path), {
            method,
            headers: { 'x-user-id': user, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const connection = (workspace: string) =>
        call(workspace, 'POST', '/connections', { name: 'Warehouse', type: 'http-client', config: { auth: 'none' } }).then(
            r => r.body.id as string,
        );

    /** a project with a flow whose draft picks the Warehouse profile and reads $SECRETS.token and $VARIABLES.region, deployed */
    const project = async (name: string, connectionId: string) => {
        const projectId = (await call(from, 'POST', '/projects', { name })).body.id as string;
        const flowId = (await call(from, 'POST', `/projects/${projectId}/flows`, { name: 'Send' })).body.id as string;
        const { flow, revision } = (await call(from, 'GET', `/flows/${flowId}/draft`)).body as {
            revision: number;
            flow: { nodes: Node[] };
        };
        const request: Node = {
            id: 'req',
            type: 'http-request',
            position: { x: 300, y: 0 },
            config: {
                connection: connectionId,
                method: 'GET',
                url: '`https://example.com/${$VARIABLES.region}`',
                headers: [{ name: 'X-Token', value: '$SECRETS.token', expression: true }],
            },
        };
        expect(
            (await call(from, 'PUT', `/flows/${flowId}/draft`, { revision, flow: { ...flow, nodes: [...flow.nodes, request] } })).status,
        ).toBe(200);
        expect((await call(from, 'POST', `/flows/${flowId}/deploy`)).status).toBe(200);
        return { projectId, flowId };
    };

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, from, 'From');
        await insertWorkspace(db, to, 'To');
        app = createApp(db, 'DEV', new Keyring([{ version: 't', key: new Uint8Array(32).fill(9) }]));
    });
    afterAll(() => db.close());

    test('refused, nothing moved, while the destination lacks a connection, a secret or a variable the flows use', async () => {
        const { projectId } = await project('Lacking', await connection(from));
        const refused = await call(from, 'POST', `/projects/${projectId}/move`, { toWorkspace: workspaceHandleOf(to) });
        expect(refused.status).toBe(409);
        expect(refused.body.error.fields).toEqual({ connections: 'Warehouse', secrets: 'token', variables: 'region' });
        expect(refused.body.error.message).toContain('connection "Warehouse", secret "token", variable "region"');
        expect((await call(from, 'GET', `/projects/${projectId}`)).status).toBe(200);
        expect((await call(to, 'GET', `/projects/${projectId}`)).status).toBe(404);
    });

    test('an admin where it is and at least an editor where it goes; a workspace that is not the user’s is not found', async () => {
        const { projectId } = await project('Guarded', (await call(from, 'GET', '/connections')).body.items[0].id);
        const editor = await insertMember(db, from, { name: 'Ed', role: 'editor' });
        await insertMember(db, to, { id: editor, name: 'Ed', role: 'admin' });
        expect((await call(from, 'POST', `/projects/${projectId}/move`, { toWorkspace: workspaceHandleOf(to) }, editor)).status).toBe(403);

        const viewerThere = await insertMember(db, from, { name: 'Vi', role: 'admin' });
        await insertMember(db, to, { id: viewerThere, name: 'Vi', role: 'viewer' });
        expect((await call(from, 'POST', `/projects/${projectId}/move`, { toWorkspace: workspaceHandleOf(to) }, viewerThere)).status).toBe(
            403,
        );
        expect((await call(from, 'POST', `/projects/${projectId}/move`, { toWorkspace: 'not-mine' })).status).toBe(404);
    });

    test('moved: everything of it in the destination, the draft on its profile of the same name, the deployed undeployed', async () => {
        const source = (await call(from, 'GET', '/connections')).body.items[0].id as string;
        const { projectId, flowId } = await project('Moving', source);
        const target = await connection(to);
        await call(to, 'POST', '/secrets', { name: 'TOKEN', value: 'x' });
        await call(to, 'POST', '/variables', { name: 'region', value: 'eu' });

        const moved = await call(from, 'POST', `/projects/${projectId}/move`, { toWorkspace: workspaceHandleOf(to) });
        expect(moved).toMatchObject({ status: 200, body: { id: projectId, workspace: workspaceHandleOf(to), undeployed: 1 } });

        expect((await call(from, 'GET', `/projects/${projectId}`)).status).toBe(404);
        expect((await call(to, 'GET', `/projects/${projectId}`)).body.name).toBe('Moving');
        const draft = (await call(to, 'GET', `/flows/${flowId}/draft`)).body as { flow: { nodes: Node[] } };
        expect(draft.flow.nodes.find(n => n.id === 'req')!.config.connection).toBe(target);
        const deployments = (await call(to, 'GET', `/flows/${flowId}/deployments`)).body;
        expect(deployments.deployed).toBeNull();
        expect(deployments.versions).toHaveLength(1);
        expect(deployments.history.map((h: { action: string }) => h.action)).toEqual(['undeploy', 'deploy']);
        const stale = await db.query(
            `SELECT 'flows' AS t FROM flows WHERE project_id = $1 AND workspace_id <> $2
       UNION ALL SELECT 'versions' FROM flow_versions v JOIN flows f ON f.id = v.flow_id WHERE f.project_id = $1 AND v.workspace_id <> $2
       UNION ALL SELECT 'history' FROM deployment_history h JOIN flows f ON f.id = h.flow_id WHERE f.project_id = $1 AND h.workspace_id <> $2`,
            [projectId, to],
        );
        expect(stale).toEqual([]);
    });

    test("moved: its imports of its own scripts name the new workspace; those of the old workspace's other projects stay", async () => {
        const [old, now] = [`@w/${workspaceHandleOf(from)}`, `@w/${workspaceHandleOf(to)}`];
        const other = (await call(from, 'POST', '/projects', { name: 'Toolbox' })).body.id as string;
        await call(from, 'POST', `/projects/${other}/scripts`, { kind: 'script', path: 'util', content: 'export const u = 1;' });
        const projectId = (await call(from, 'POST', '/projects', { name: 'Rewired' })).body.id as string;
        await call(from, 'POST', `/projects/${projectId}/scripts`, { kind: 'script', path: 'lib/b', content: 'export const b = 1;' });
        const code = `import { b } from '${old}/rewired/scripts/lib/b';\nimport { u } from '${old}/toolbox/scripts/util';\n`;
        await call(from, 'POST', `/projects/${projectId}/scripts`, { kind: 'script', path: 'lib/a', content: code });
        const flowId = (await call(from, 'POST', `/projects/${projectId}/flows`, { name: 'Calls' })).body.id as string;
        const { flow, revision } = (await call(from, 'GET', `/flows/${flowId}/draft`)).body as {
            revision: number;
            flow: { nodes: Node[] };
        };
        const nodes: Node[] = [
            { id: 'ts', type: 'typescript', position: { x: 160, y: 0 }, config: { code } },
            { id: 'fn', type: 'script', position: { x: 320, y: 0 }, config: { function: `${old}/rewired/scripts/lib/b#b` } },
        ];
        expect(
            (await call(from, 'PUT', `/flows/${flowId}/draft`, { revision, flow: { ...flow, nodes: [...flow.nodes, ...nodes] } })).status,
        ).toBe(200);

        expect((await call(from, 'POST', `/projects/${projectId}/move`, { toWorkspace: workspaceHandleOf(to) })).status).toBe(200);
        const rewired = `import { b } from '${now}/rewired/scripts/lib/b';\nimport { u } from '${old}/toolbox/scripts/util';\n`;
        expect((await call(to, 'GET', `/projects/${projectId}/scripts/content?path=lib/a`)).body.content).toBe(rewired);
        const draft = (await call(to, 'GET', `/flows/${flowId}/draft`)).body as { flow: { nodes: Node[] } };
        expect(draft.flow.nodes.find(n => n.id === 'ts')!.config.code).toBe(rewired);
        expect(draft.flow.nodes.find(n => n.id === 'fn')!.config.function).toBe(`${now}/rewired/scripts/lib/b#b`);

        await db.query(`INSERT INTO supervisors (id, tags, workers, host) VALUES ('sup-move', '{default}', 1, 'test')`);
        const run = await call(to, 'POST', `/flows/${flowId}/runs`, { mode: 'validation' });
        expect(run.body.error.message).toBe(
            `The flow cannot run: "TypeScript" imports ${old}/toolbox/scripts/util: only scripts of this workspace (${now}/<project>/scripts/<path>).`,
        );
    });
});
