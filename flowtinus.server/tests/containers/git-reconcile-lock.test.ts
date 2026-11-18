import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(60_000);

// PGlite has a single session, where an advisory lock is always granted: the lock needs a real Postgres
const container: StartedPostgreSqlContainer | null = await new PostgreSqlContainer('postgres:17.6-alpine').start().catch(() => null);

describe.skipIf(!container)('one reconcile of a workspace at a time (Postgres)', () => {
    let db: Database;
    let dir: string;
    let app: ReturnType<typeof createApp>;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    beforeAll(async () => {
        db = await openDatabase(container!.getConnectionUri());
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-reconcile-lock-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db?.close();
        await container?.stop();
        await rm(dir, { recursive: true, force: true });
    });

    test('a reconcile while another holds the workspace is refused; once it is done, the next one runs', async () => {
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
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        createBranch(repo, 'dev');
        expect((await call('POST', '/git/on', {})).status).toBe(200);

        const other = await openDatabase(container!.getConnectionUri());
        try {
            await other.transaction(async tx => {
                await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`reconcile:${id}`]);
                const busy = await call('POST', '/git/reconcile');
                expect(busy.status).toBe(409);
                expect(busy.body.error.message).toBe('A reconcile of this workspace is already running.');
            });
        } finally {
            await other.close();
        }

        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');
    });
});
