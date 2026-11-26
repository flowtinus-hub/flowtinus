import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

describe('the git status the git section and the sidebar read', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace(options: { git?: boolean } = {}) {
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
        await call('POST', '/projects', { name: 'Sales' });
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        if (options.git !== false) {
            await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
            await call('PUT', '/git', { repository: pathToFileURL(repo).href, tokenSecret: 'git-token', environment: 'DEV' });
            expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
            expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        }
        const show = (file: string) => Bun.spawnSync(['git', 'show', `dev:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        const onBranch = (): Record<string, string> =>
            Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', 'dev')
                    .split('\n')
                    .map(file => [file, show(file)]),
            );
        const status = async () => (await call('GET', '/git/status')).body;
        return { id, handle: workspaceHandleOf(id), call, repo, onBranch, status };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-status-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a refused commit shows its sha, message, author and errors per file, next to the commit the deploy is on', async () => {
        const { handle, call, repo, onBranch, status } = await newWorkspace();
        const deployed = git(repo, 'rev-parse', 'dev');
        expect(await status()).toEqual({
            on: true,
            branch: 'dev',
            mode: 'direct',
            deploy: { sha: deployed, message: `First export of ${handle}`, author: 'Ana', at: expect.any(String) },
            refused: null,
            unreachable: null,
            warnings: [],
            renamedDrafts: [],
            lastPoll: null,
        });

        const projectFile = `${handle}/projects/Sales/project.yaml`;
        const broken = commitFiles(repo, 'dev', { ...onBranch(), [projectFile]: 'id: [not a project' }, 'Break the project');
        const reconciled = await call('POST', '/git/reconcile');
        expect(reconciled.body.outcome).toBe('refused');

        const now = await status();
        expect(now.deploy.sha).toBe(deployed);
        expect(now.refused).toMatchObject({ sha: broken, message: 'Break the project', author: 'Someone', refusedAt: expect.any(String) });
        expect(now.refused.errors.map((e: { path: string }) => e.path)).toEqual([projectFile]);
        expect(now.lastPoll).toEqual({ at: expect.any(String) });
    });

    test('an unreachable repository shows since when; once it answers again it does not', async () => {
        const { call, repo, status } = await newWorkspace();
        await rename(repo, `${repo}.away`);
        expect((await call('POST', '/git/reconcile')).status).toBe(502);
        const first = (await status()).unreachable;
        expect(first).toEqual({ since: expect.any(String), error: expect.stringContaining('The repository answered') });
        await Bun.sleep(20);
        await call('POST', '/git/reconcile');
        const second = await status();
        expect(second.unreachable.since).toBe(first.since);
        expect(second.lastPoll.at > first.since).toBe(true);

        await rename(`${repo}.away`, repo);
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('up-to-date');
        expect((await status()).unreachable).toBeNull();
    });

    test("a commit's warnings show after it applied", async () => {
        const { handle, call, repo, onBranch, status } = await newWorkspace();
        const applied = commitFiles(repo, 'dev', { ...onBranch(), [`${handle}/notes.txt`]: 'not a workspace file' }, 'Add notes');
        expect((await call('POST', '/git/reconcile')).body.outcome).toBe('applied');
        const now = await status();
        expect(now.deploy).toMatchObject({ sha: applied, message: 'Add notes' });
        expect(now.warnings).toEqual([
            { path: `${handle}/notes.txt`, message: 'It is not part of the repository format: it is left out.' },
        ]);
    });

    test('with git off the status says only that', async () => {
        const { status } = await newWorkspace({ git: false });
        expect(await status()).toEqual({ on: false });
    });
});
