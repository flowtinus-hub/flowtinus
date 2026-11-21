import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

describe('workspace scripts api', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    const workspaceId = crypto.randomUUID();
    const ws = workspaceHandleOf(workspaceId);
    const headers = { 'x-user-id': ANA, 'content-type': 'application/json' };
    const call = async (method: string, path: string, body?: unknown) => {
        const response = await app.request(wsPath(workspaceId, path), {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    beforeAll(async () => {
        db = await openDatabase('memory://');
        await insertWorkspace(db, workspaceId, 'acme');
        app = createApp(db, 'DEV', new Keyring([{ version: 't', key: new Uint8Array(32).fill(5) }]));
    });

    afterAll(async () => {
        await db.close();
    });

    test("every project's scripts with their import paths and exports, grouped by project; an archived project's left out", async () => {
        const billing = (await call('POST', '/projects', { name: 'Billing' })).body.id as string;
        const shared = (await call('POST', '/projects', { name: 'Shared Lib' })).body.id as string;
        const old = (await call('POST', '/projects', { name: 'Old' })).body.id as string;
        const empty = (await call('POST', '/projects', { name: 'Empty' })).body.id as string;
        await call('POST', `/projects/${billing}/scripts`, { kind: 'script', path: 'prices', content: 'export function price() {}' });
        await call('POST', `/projects/${shared}/scripts`, { kind: 'script', path: 'math/round', content: 'export type Round = number;' });
        await call('POST', `/projects/${old}/scripts`, { kind: 'script', path: 'gone', content: 'export const x = 1;' });
        await call('POST', `/projects/${old}/archive`);

        const listed = await call('GET', '/scripts');

        expect(listed.status).toBe(200);
        expect(listed.body).toEqual({
            projects: [
                {
                    id: billing,
                    name: 'Billing',
                    handle: 'billing',
                    scripts: [
                        {
                            path: 'prices',
                            importPath: `@w/${ws}/billing/scripts/prices`,
                            exports: [{ name: 'price', typeOnly: false, function: true }],
                        },
                    ],
                },
                { id: empty, name: 'Empty', handle: 'empty', scripts: [] },
                {
                    id: shared,
                    name: 'Shared Lib',
                    handle: 'shared-lib',
                    scripts: [
                        {
                            path: 'math/round',
                            importPath: `@w/${ws}/shared-lib/scripts/math/round`,
                            exports: [{ name: 'Round', typeOnly: true }],
                        },
                    ],
                },
            ],
        });
    });
});
