import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ANA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

describe('names valid as file names', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let projectId: string;
    const workspaceId = crypto.randomUUID();
    const headers = { 'x-user-id': ANA, 'content-type': 'application/json' };

    const call = async (method: string, path: string, body?: unknown) => {
        const response = await app.request(wsPath(workspaceId, path), {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const fields = (result: { body: Record<string, unknown> }) => (result.body.error as { fields?: Record<string, string> }).fields;

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId, 'acme');
        app = createApp(db, 'DEV');
        projectId = (await call('POST', '/projects', { name: 'Names' })).body.id as string;
    });

    afterAll(async () => {
        await db.close();
    });

    test('a project, folder, flow or connection name that is not a valid file name is refused with its reason', async () => {
        const project = await call('POST', '/projects', { name: 'Sales: 2026' });
        expect(project.status).toBe(400);
        expect(fields(project)).toEqual({ name: 'None of \\ / : * ? " < > |' });
        expect(fields(await call('PATCH', `/projects/${projectId}`, { name: 'Names.' }))).toEqual({ name: 'Not ending in a dot' });

        const folder = await call('POST', `/projects/${projectId}/folders`, { name: 'nul.txt' });
        expect(folder.status).toBe(400);
        expect(fields(folder)).toEqual({ name: '"nul" is a name Windows reserves' });
        expect(fields(await call('POST', `/projects/${projectId}/folders`, { name: 'Orders.flow.yaml' }))).toEqual({
            name: 'A folder name cannot end in .flow.yaml',
        });

        const flow = await call('POST', `/projects/${projectId}/flows`, { name: 'Load\torders' });
        expect(flow.status).toBe(400);
        expect(fields(flow)).toEqual({ name: 'No control characters' });
        expect((await call('POST', `/projects/${projectId}/flows`, { name: 'Orders.flow.yaml' })).status).toBe(201);
        const flowId = (await call('POST', `/projects/${projectId}/flows`, { name: 'Load' })).body.id as string;
        expect(fields(await call('PATCH', `/flows/${flowId}`, { name: 'COM1' }))).toEqual({ name: '"COM1" is a name Windows reserves' });
        expect(fields(await call('POST', `/flows/${flowId}/clone`, { name: '..' }))).toEqual({ name: 'Not "." or ".."' });

        const connection = await call('POST', '/connections', { name: 'Warehouse?', type: 'http-client', config: { auth: 'none' } });
        expect(connection.status).toBe(400);
        expect(fields(connection)).toMatchObject({ name: 'None of \\ / : * ? " < > |' });
    });

    test('names are stored in NFC, and a sibling differing only in case or normalization is taken', async () => {
        const nfd = 'Café';
        const created = await call('POST', `/projects/${projectId}/folders`, { name: nfd });
        expect(created.status).toBe(201);
        const contents = (await call('GET', `/projects/${projectId}/contents`)).body as { folders: { id: string; name: string }[] };
        expect(contents.folders.find(f => f.id === created.body.id)?.name).toBe('Café');

        expect((await call('POST', `/projects/${projectId}/folders`, { name: 'CAFÉ' })).status).toBe(409);
        expect((await call('POST', '/projects', { name: 'NAMES' })).status).toBe(409);
        expect((await call('POST', '/projects', { name: 'Projét' })).status).toBe(201);
        expect((await call('POST', '/projects', { name: 'projét' })).status).toBe(409);
    });

    test('a change that makes a path in the repository longer than 150 characters is refused', async () => {
        const project = (await call('POST', '/projects', { name: 'Deep' })).body.id as string;
        let parentId: string | null = null;
        for (const name of ['Sales department', 'Monthly reports and more', 'Region north east']) {
            parentId = (await call('POST', `/projects/${project}/folders`, { name, parentId })).body.id as string;
        }
        const flowId = (await call('POST', `/projects/${project}/flows`, { name: 'Load', folderId: parentId })).body.id as string;

        const longName = 'Load the orders of the day, the week, the month and the year';
        const renamed = await call('PATCH', `/flows/${flowId}`, { name: longName });
        expect(renamed.status).toBe(400);
        const path = `${slugOf(workspaceId)}/projects/Deep/flows/Sales department/Monthly reports and more/Region north east/${longName}.flow.yaml`;
        expect(fields(renamed)?.name).toBe(`The path "${path}" in the repository would have ${path.length} characters (at most 150)`);
        expect(fields(await call('PATCH', `/projects/${project}`, { name: 'Deep and much, much longer than before' }))?.name).toContain(
            'in the repository would have',
        );
        expect((await call('PATCH', `/flows/${flowId}`, { name: 'Load the orders of the day' })).status).toBe(200);
    });

    test('a script path: no segment Windows reserves, none differing only in case from what is there, and a short enough path', async () => {
        const create = (path: string, kind = 'script') =>
            call('POST', `/projects/${projectId}/scripts`, { kind, path, content: 'export const a = 1;' });
        expect((await create('upload/types')).status).toBe(201);

        const reserved = await create('upload/aux');
        expect(reserved.status).toBe(400);
        expect(fields(reserved)).toEqual({ path: '"aux": "aux" is a name Windows reserves.' });

        const clash = await create('Upload/headers');
        expect(clash.status).toBe(400);
        expect(fields(clash)).toEqual({ path: '"Upload" differs only in case from "upload": a disk that ignores case holds only one.' });

        expect((await call('POST', `/projects/${projectId}/scripts/move`, { from: 'upload', to: 'Upload' })).status).toBe(200);

        const long = await create(['a'.repeat(60), 'b'.repeat(60)].join('/'));
        expect(long.status).toBe(400);
        expect(fields(long)?.path).toContain('in the repository would have');
    });
});
