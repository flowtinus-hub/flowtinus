import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { ANA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

describe('project handles', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    const workspaceId = crypto.randomUUID();

    const call = async (method: string, path: string, body?: unknown, workspace = workspaceId) => {
        const response = await app.request(wsPath(workspace, path), {
            method,
            headers: { 'x-user-id': ANA, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const create = async (name: string) => (await call('POST', '/projects', { name })).body.id as string;

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId);
        app = createApp(db, 'DEV');
    });
    afterAll(() => db.close());

    test('made from the name on create and on rename, and listed', async () => {
        const id = await create('Vendás BR (Norte)!');
        expect((await call('GET', `/projects/${id}`)).body.handle).toBe('vendas-br-norte');

        const renamed = await call('PATCH', `/projects/${id}`, { name: `${'Long name '.repeat(4)}end` });
        expect(renamed.body.handle).toBe('long-name-long-name-long-name-long-name');
        const listed = (await call('GET', '/projects')).body.items as { id: string; handle: string }[];
        expect(listed.find(p => p.id === id)!.handle).toBe('long-name-long-name-long-name-long-name');
    });

    test('a name that makes no handle is refused on create and on rename', async () => {
        const created = await call('POST', '/projects', { name: 'Привет!' });
        expect(created.status).toBe(400);
        expect(created.body.error.fields).toEqual({ name: 'No letter or digit (a-z, 0-9) to make its handle from' });

        const id = await create('Empty later');
        expect((await call('PATCH', `/projects/${id}`, { name: '!!!' })).status).toBe(400);
    });

    test('a handle another project has refuses the create and the rename, naming that project', async () => {
        const id = await create('Vendas BR');
        const created = await call('POST', '/projects', { name: 'Vendas-BR' });
        expect(created.status).toBe(409);
        expect(created.body.error).toMatchObject({
            message: 'The handle "vendas-br" is taken by the project "Vendas BR".',
            fields: { name: 'Handle taken by "Vendas BR"' },
        });

        const other = await create('Compras');
        expect((await call('PATCH', `/projects/${other}`, { name: 'vendás br' })).body.error.message).toBe(
            'The handle "vendas-br" is taken by the project "Vendas BR".',
        );
        expect((await call('PATCH', `/projects/${id}`, { name: 'Vendas  BR' })).status).toBe(200);
    });

    test('an archived project keeps its handle; deleted for good, it frees it', async () => {
        const id = await create('Old Reports');
        await call('POST', `/projects/${id}/archive`);

        const created = await call('POST', '/projects', { name: 'old reports' });
        expect(created.status).toBe(409);
        expect(created.body.error.message).toBe('The handle "old-reports" is taken by the archived project "Old Reports".');

        await db.query('DELETE FROM projects WHERE id = $1', [id]);
        expect((await call('POST', '/projects', { name: 'old reports' })).status).toBe(201);
    });

    test('restoring a project whose handle another has is refused', async () => {
        const id = await create('Pagos');
        await call('POST', `/projects/${id}/archive`);
        const other = await create('Pagos later');
        await db.query(`UPDATE projects SET name = 'PAGOS' WHERE id = $1`, [other]);

        const restored = await call('POST', `/projects/${id}/restore`);
        expect(restored.status).toBe(409);
        expect(restored.body.error.message).toBe('The handle "pagos" is taken by the project "PAGOS".');
    });

    test('moving a project into a workspace where a project, archived ones included, has its handle is refused', async () => {
        const target = crypto.randomUUID();
        await insertWorkspace(db, target, 'Target');
        const there = (await call('POST', '/projects', { name: 'Fretes' }, target)).body.id as string;
        await call('POST', `/projects/${there}/archive`, undefined, target);
        const id = await create('fretes!');

        const moved = await call('POST', `/projects/${id}/move`, { toWorkspace: slugOf(target) });
        expect(moved.status).toBe(409);
        expect(moved.body.error).toMatchObject({
            message: `The handle "fretes" is taken by the archived project "Fretes" in "${slugOf(target)}".`,
            fields: { toWorkspace: 'Handle taken by "Fretes"' },
        });
    });
});
