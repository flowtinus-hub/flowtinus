import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { ANA, insertMember, insertWorkspace, wsPath } from '../helpers/workspaces';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

/**
 * What each role may do in a workspace (the plan's matrix): a viewer reads, an editor also changes (and runs), an admin
 * also manages the workspace. Each row: the viewer is refused (403), the editor is not; the admin rows: the editor is
 * refused, the admin is not.
 */
describe('roles in a workspace', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    const workspaceId = crypto.randomUUID();
    let viewer = '';
    let editor = '';

    const as = async (user: string, method: string, path: string, body?: unknown) => {
        const response = await app.request(wsPath(workspaceId, path), {
            method,
            headers: { 'x-user-id': user, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const admin = (method: string, path: string, body?: unknown) => as(ANA, method, path, body);

    /** a new project with a flow (its draft has a Start and an End) and a folder, made by an admin */
    const fixture = async () => {
        const projectId = (await admin('POST', '/projects', { name: crypto.randomUUID() })).body.id as string;
        const folderId = (await admin('POST', `/projects/${projectId}/folders`, { name: 'F' })).body.id as string;
        const flowId = (await admin('POST', `/projects/${projectId}/flows`, { name: 'Flow' })).body.id as string;
        return { projectId, folderId, flowId };
    };

    /** the viewer is refused, the editor is not */
    const editorsOnly = async (method: string, path: string, body?: unknown) => {
        const refused = await as(viewer, method, path, body);
        expect({ path, status: refused.status, code: refused.body.error?.code }).toEqual({ path, status: 403, code: 'forbidden' });
        const allowed = await as(editor, method, path, body);
        expect({ path, refused: allowed.status === 403 }).toEqual({ path, refused: false });
        return allowed;
    };

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId);
        viewer = await insertMember(db, workspaceId, { name: 'Vi', role: 'viewer' });
        editor = await insertMember(db, workspaceId, { name: 'Ed', role: 'editor' });
        app = createApp(db, 'DEV', new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]));
    });
    afterAll(() => db.close());

    test('a viewer sees projects, flows, scripts, runs and the names of connections, secrets and variables', async () => {
        const { projectId, flowId } = await fixture();
        await admin('POST', '/secrets', { name: 'seen-secret', value: 'never shown' });
        for (const path of [
            '/projects',
            `/projects/${projectId}`,
            `/projects/${projectId}/contents`,
            `/projects/${projectId}/scripts`,
            `/flows/${flowId}`,
            `/flows/${flowId}/draft`,
            `/flows/${flowId}/deployments`,
            '/connections',
            '/secrets',
            '/variables',
            '/members',
            '',
        ]) {
            expect({ path, status: (await as(viewer, 'GET', path)).status }).toEqual({ path, status: 200 });
        }
        expect((await app.request('/runs', { headers: { 'x-user-id': viewer } })).status).toBe(200);
        expect(JSON.stringify((await as(viewer, 'GET', '/secrets')).body)).not.toContain('never shown');
    });

    test('a test run (the editor’s Run) and a run for real: editors', async () => {
        const { flowId } = await fixture();
        await editorsOnly('POST', `/flows/${flowId}/runs`, { mode: 'validation' });
        await editorsOnly('POST', `/flows/${flowId}/runs`, { mode: 'execution' });
    });

    test('projects, folders, flows and scripts: created and changed by editors', async () => {
        const { projectId, folderId, flowId } = await fixture();
        await editorsOnly('POST', '/projects', { name: crypto.randomUUID() });
        await editorsOnly('PATCH', `/projects/${projectId}`, { description: 'Changed' });
        await editorsOnly('POST', `/projects/${projectId}/folders`, { name: crypto.randomUUID() });
        await editorsOnly('PATCH', `/folders/${folderId}`, { name: crypto.randomUUID() });
        await editorsOnly('POST', `/projects/${projectId}/flows`, { name: crypto.randomUUID() });
        await editorsOnly('PATCH', `/flows/${flowId}`, { name: crypto.randomUUID() });
        await editorsOnly('POST', `/flows/${flowId}/move`, { folderId });
        await editorsOnly('POST', `/flows/${flowId}/clone`, { name: crypto.randomUUID() });
        await editorsOnly('PUT', `/flows/${flowId}/worker-tag`, { workerTag: 'default' });
        const draft = (await admin('GET', `/flows/${flowId}/draft`)).body;
        await editorsOnly('PUT', `/flows/${flowId}/draft`, { revision: draft.revision, flow: draft.flow });
        await editorsOnly('POST', `/projects/${projectId}/scripts`, { path: `s${Date.now()}.ts`, kind: 'file' });
    });

    test('deploy and undeploy, schedules and webhooks: editors', async () => {
        const { flowId } = await fixture();
        await editorsOnly('POST', `/flows/${flowId}/deploy`);
        await editorsOnly('POST', `/flows/${flowId}/undeploy`);
        await editorsOnly('POST', `/flows/${flowId}/schedules`, { cron: '0 * * * *', timezone: 'UTC', enabled: false });
        await editorsOnly('POST', `/flows/${flowId}/webhooks`, { name: crypto.randomUUID() });
    });

    test('archive a flow, a folder or a project: editors', async () => {
        const { projectId, folderId, flowId } = await fixture();
        await editorsOnly('POST', `/flows/${flowId}/archive`);
        await editorsOnly('POST', `/folders/${folderId}/archive`);
        await editorsOnly('POST', `/projects/${projectId}/archive`);
    });

    test('connections, secrets and variables: created and changed by editors', async () => {
        await editorsOnly('POST', '/secrets', { name: `s${crypto.randomUUID().slice(0, 8)}`, value: 'v' });
        await editorsOnly('POST', '/variables', { name: `v${crypto.randomUUID().slice(0, 8)}`, value: 'v' });
        const secret = (await admin('POST', '/secrets', { name: 'replaced', value: 'v' })).body.id as string;
        await editorsOnly('PUT', `/secrets/${secret}/value`, { value: 'w' });
        const variable = (await admin('POST', '/variables', { name: 'changed', value: 'v' })).body.id as string;
        await editorsOnly('PATCH', `/variables/${variable}`, { value: 'w' });
        const connection = { type: 'http-client', config: { auth: 'none' } };
        await editorsOnly('POST', '/connections', { name: crypto.randomUUID().slice(0, 20), ...connection });
        await editorsOnly('POST', '/connections/test', connection);
        await editorsOnly('DELETE', `/secrets/${secret}`);
        await editorsOnly('DELETE', `/variables/${variable}`);
    });

    test('the workspace itself and its members: admins', async () => {
        for (const [method, path, body] of [
            ['PATCH', '', { description: 'By an admin' }],
            ['POST', '/members', { email: `${viewer}@example.com`, role: 'viewer' }],
            ['PATCH', `/members/${viewer}`, { role: 'viewer' }],
            ['POST', '/archive', undefined],
        ] as const) {
            const refused = await as(editor, method, path, body);
            expect({ path, status: refused.status }).toEqual({ path, status: 403 });
            const allowed = await admin(method, path, body);
            expect({ path, refused: allowed.status === 403 }).toEqual({ path, refused: false });
        }
    });
});
