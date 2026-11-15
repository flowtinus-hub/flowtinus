import type { Database } from '#shared/database/database';

/** the users the api tests call as (X-User-Id): members (admins) of every workspace insertWorkspace makes */
export const ANA = '0a0a0a0a-0000-4000-8000-00000000a0a0';
export const BIA = '0b0b0b0b-0000-4000-8000-00000000b0b0';

export const slugOf = (id: string) => `w-${id.replaceAll('-', '').slice(0, 24)}`;

/** the workspace's address of an api path (/projects... becomes /w/<slug>/projects...); the environment's stay as they are */
export const wsPath = (workspaceId: string, path: string) =>
    /^\/(runs|workers|wh|me|workspaces|mcp|health|tokens)(\/|\?|$)/.test(path) ? path : `/w/${slugOf(workspaceId)}${path}`;

/** a workspace for a test (its slug from its id unless given), with ANA and BIA its admins */
export async function insertWorkspace(db: Database, id: string, name = 'acme', slug = slugOf(id)): Promise<void> {
    await db.query('INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $3)', [id, slug, name]);
    await insertMember(db, id, { id: ANA, name: 'Ana' });
    await insertMember(db, id, { id: BIA, name: 'Bia' });
}

/** a user of the environment (a new id unless given), a member of the workspace with this role; returns the user's id */
export async function insertMember(
    db: Database,
    workspaceId: string,
    options: { id?: string; name?: string; role?: 'admin' | 'editor' | 'viewer'; isAdmin?: boolean } = {},
): Promise<string> {
    const id = options.id ?? crypto.randomUUID();
    const name = options.name ?? 'Ana';
    await db.query('INSERT INTO users (id, name, email, is_admin) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [
        id,
        name,
        `${id}@example.com`,
        options.isAdmin ?? false,
    ]);
    await db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [workspaceId, id, options.role ?? 'admin'],
    );
    return id;
}

export async function insertUser(db: Database, name = 'Out', isAdmin = false): Promise<string> {
    const id = crypto.randomUUID();
    await db.query('INSERT INTO users (id, name, email, is_admin) VALUES ($1, $2, $3, $4)', [id, name, `${id}@example.com`, isAdmin]);
    return id;
}
