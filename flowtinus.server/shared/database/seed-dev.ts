import { API_SCOPES, insertApiToken } from '#features/api-tokens/api-tokens';
import type { Database } from './database';

/*
 * PLACEHOLDER until authentication exists
 */

export const DEV_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const DEV_WORKSPACE_HANDLE = 'dev';
export const DEV_USER = { id: '00000000-0000-4000-8000-000000000002', name: 'Dev', email: 'dev@example.com' };

/**
 * The dev user's personal access token, for an agent on this machine (the MCP at /mcp): every v1 scope, no expiry. Fine in
 * git: the seed only runs in DEV, never with real data. SEED_DEV_PAT (flowtinus.server/.env) replaces the value.
 */
export const DEV_PAT = 'ftn_dev_local_only_change_with_SEED_DEV_PAT';
export const DEV_PAT_ID = '00000000-0000-4000-8000-000000000003';

export async function seedDev(db: Database, pat = process.env.SEED_DEV_PAT || DEV_PAT): Promise<void> {
    await db.query(
        `INSERT INTO workspaces (id, handle, name)
                    VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [DEV_WORKSPACE_ID, DEV_WORKSPACE_HANDLE, 'Dev'],
    );
    await db.query(
        `INSERT INTO users (id, name, email, is_admin)
                    VALUES ($1, $2, $3, true) ON CONFLICT (id) DO NOTHING`,
        [DEV_USER.id, DEV_USER.name, DEV_USER.email],
    );
    await db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role)
                    VALUES ($1, $2, 'admin') ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [DEV_WORKSPACE_ID, DEV_USER.id],
    );
    await insertApiToken(db, {
        id: DEV_PAT_ID,
        userId: DEV_USER.id,
        name: 'Dev (seed)',
        token: pat,
        scopes: API_SCOPES,
    });
}
