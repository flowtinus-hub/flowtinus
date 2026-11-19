import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { commitAll, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(60_000);

// PGlite has a single session, where an advisory lock is always granted: the lock needs a real Postgres
const container: StartedPostgreSqlContainer | null = await new PostgreSqlContainer('postgres:17.6-alpine').start().catch(() => null);

describe.skipIf(!container)('turning git off waits for a running reconcile (Postgres)', () => {
    let db: Database;
    let dir: string;
    let app: ReturnType<typeof createApp>;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    beforeAll(async () => {
        db = await openDatabase(container!.getConnectionUri());
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-off-lock-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db?.close();
        await container?.stop();
        await rm(dir, { recursive: true, force: true });
    });

    async function workspaceWithAScript() {
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
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        expect(
            (
                await call('POST', `/projects/${projectId}/scripts`, {
                    kind: 'script',
                    path: 'lib/prices',
                    content: 'export const value = 1;',
                })
            ).status,
        ).toBe(201);
        expect((await commitAll(call, 'Prices')).status).toBe(200);
        const deployed = async () =>
            (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM deployed_scripts WHERE workspace_id = $1', [id]))[0]!.n;
        expect(await deployed()).toBe(1);
        return { id, call, repo, deployed };
    }

    // holds the workspace's reconcile lock, as a reconcile does, and writes the deployed set again once `turnOff` has had time to run
    async function duringAReconcile(id: string, turnOff: () => Promise<{ status: number }>) {
        const other = await openDatabase(container!.getConnectionUri());
        let answered: Promise<{ status: number }> | undefined;
        try {
            await other.transaction(async tx => {
                await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`reconcile:${id}`]);
                const rows = await tx.query<{ project_id: string; path: string; hash: string; commit_sha: string }>(
                    'SELECT project_id, path, hash, commit_sha FROM deployed_scripts WHERE workspace_id = $1',
                    [id],
                );
                answered = turnOff();
                await Bun.sleep(500);
                for (const row of rows) {
                    await tx.query(
                        `INSERT INTO deployed_scripts (workspace_id, project_id, path, hash, commit_sha) VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (project_id, path) DO UPDATE SET hash = $4, commit_sha = $5`,
                        [id, row.project_id, row.path, row.hash, row.commit_sha],
                    );
                }
            });
        } finally {
            await other.close();
        }
        return answered!;
    }

    test('saving git off leaves no deployed set behind', async () => {
        const { id, call, repo, deployed } = await workspaceWithAScript();
        const off = await duringAReconcile(id, () =>
            call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'PROD' }),
        );
        expect(off.status).toBe(200);
        expect((await call('GET', '/git')).body.on).toBe(false);
        expect(await deployed()).toBe(0);
    });

    test('removing git leaves no deployed set behind', async () => {
        const { id, call, deployed } = await workspaceWithAScript();
        const removed = await duringAReconcile(id, () => call('DELETE', '/git'));
        expect(removed.status).toBe(200);
        expect(await deployed()).toBe(0);
    });
});
