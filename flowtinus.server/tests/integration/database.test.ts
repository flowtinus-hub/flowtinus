import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { insertWorkspace } from '../helpers/workspaces';
import { openDatabase } from '../../shared/database/database';
import { migrate, readMigrations } from '../../shared/database/migrate';

// PGlite starts a whole Postgres in WebAssembly: the first test can take several seconds
setDefaultTimeout(30_000);

describe('database', () => {
    test('applies every migration to an empty database', async () => {
        const db = await openDatabase('memory://');
        try {
            const applied = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
            // by name, 10_ sorts before 1_: the same set
            expect(applied.map(r => r.name).sort()).toEqual((await readMigrations()).map(m => m.name).sort());
            const tables = await db.query<{ table_name: string }>(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
            );
            expect(tables.map(t => t.table_name).sort()).toEqual(
                [
                    'api_tokens',
                    'connections',
                    'deployment_history',
                    'deployments',
                    'flow_schedules',
                    'flow_versions',
                    'flow_webhooks',
                    'flows',
                    'folders',
                    'workspace_members',
                    'workspace_settings',
                    'workspaces',
                    'projects',
                    'runs',
                    'schema_migrations',
                    'script_blobs',
                    'script_folders',
                    'scripts',
                    'secrets',
                    'supervisors',
                    'test_runs',
                    'users',
                    'variables',
                ].sort(),
            );
        } finally {
            await db.close();
        }
    });

    test('running again applies nothing', async () => {
        const db = await openDatabase('memory://');
        try {
            expect(await migrate(db)).toEqual([]);
        } finally {
            await db.close();
        }
    });

    test('an edited migration is an error', async () => {
        const db = await openDatabase('memory://');
        try {
            const [first, ...rest] = await readMigrations();
            const edited = { ...first!, sql: `${first!.sql}\n-- edited`, checksum: 'different' };
            await expect(migrate(db, [edited, ...rest])).rejects.toThrow(/was edited after it was applied/);
        } finally {
            await db.close();
        }
    });

    test('an execution run needs a version', async () => {
        const db = await openDatabase('memory://');
        try {
            const workspace = crypto.randomUUID();
            await insertWorkspace(db, workspace, 'Acme');
            await expect(
                db.query(
                    "INSERT INTO runs (id, workspace_id, flow_id, mode, status, trigger) VALUES ($1, $2, $3, 'execution', 'queued', 'manual')",
                    [crypto.randomUUID(), workspace, crypto.randomUUID()],
                ),
            ).rejects.toThrow();
        } finally {
            await db.close();
        }
    });
});

describe('without Postgres', () => {
    test('no DATABASE_URL, or a Postgres that does not answer: one clear message on what to do', async () => {
        const { DatabaseUnavailableError } = await import('#shared/database/database');
        await expect(openDatabase(undefined)).rejects.toBeInstanceOf(DatabaseUnavailableError);
        await expect(openDatabase(undefined)).rejects.toThrow('docker compose up -d');
        const unreachable = openDatabase('postgres://flowtinus:flowtinus@127.0.0.1:1/flowtinus');
        await expect(unreachable).rejects.toBeInstanceOf(DatabaseUnavailableError);
        await expect(openDatabase('postgres://flowtinus:flowtinus@127.0.0.1:1/flowtinus')).rejects.toThrow(
            'Postgres at postgres://127.0.0.1:1/flowtinus does not answer.',
        );
    });
});
