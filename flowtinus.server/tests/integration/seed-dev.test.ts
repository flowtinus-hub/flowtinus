import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { openDatabase } from '#shared/database/database';
import { DEV_PAT, DEV_WORKSPACE_ID, DEV_USER, seedDev, seedLocal } from '#shared/database/seed-dev';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

describe('dev seed', () => {
    test('creates the DEV workspace, its admin user and the membership once, however many times it runs', async () => {
        const db = await openDatabase('memory://');
        try {
            await seedDev(db);
            await seedDev(db);

            const rows = await db.query<{ handle: string; name: string }>('SELECT handle, name FROM workspaces WHERE id = $1', [
                DEV_WORKSPACE_ID,
            ]);
            expect(rows).toEqual([{ handle: 'dev', name: 'Dev' }]);
            const users = await db.query<{ id: string; name: string; email: string; is_admin: boolean }>(
                'SELECT id, name, email, is_admin FROM users',
            );
            expect(users).toEqual([{ id: DEV_USER.id, name: DEV_USER.name, email: DEV_USER.email, is_admin: true }]);
            expect(await db.query('SELECT workspace_id, user_id, role FROM workspace_members')).toEqual([
                { workspace_id: DEV_WORKSPACE_ID, user_id: DEV_USER.id, role: 'admin' },
            ]);
        } finally {
            await db.close();
        }
    });
});

describe('local seed', () => {
    test('one admin user and a token for the MCP, never a workspace, however many times it runs', async () => {
        const db = await openDatabase('memory://');
        try {
            await seedLocal(db);
            await seedLocal(db);

            expect(await db.query('SELECT id FROM workspaces')).toEqual([]);
            expect(await db.query('SELECT id, is_admin FROM users')).toEqual([{ id: DEV_USER.id, is_admin: true }]);
            const app = createApp(db, 'LOCAL');
            const listed = await app.request('/mcp', {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${DEV_PAT}`,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
            });
            expect(listed.status).toBe(200);
        } finally {
            await db.close();
        }
    });
});
