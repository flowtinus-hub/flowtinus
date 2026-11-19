import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, BIA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

describe('open a pull request: the branch is on the remote, and a link to the provider when the app knows it', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    let gitConfig: string;
    const globalBefore = process.env.GIT_CONFIG_GLOBAL;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace(repository: string | null) {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const as = (user: string) => async (method: string, path: string, body?: unknown) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': user, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const call = as(ANA);
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        if (repository) {
            git(dir, 'config', '--file', gitConfig, '--add', `url.${pathToFileURL(repo).href}.insteadOf`, repository);
        }
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        const saved = await call('PUT', '/git', {
            repository: repository ?? pathToFileURL(repo).href,
            tokenSecret: 'git-token',
            environment: 'DEV',
        });
        expect(saved.status).toBe(200);
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        const orders = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
        expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
        await app.gitPoller.poll(id);

        const handle = async (user: string) => (await as(user)('GET', '/me')).body.handle as string;
        const commitFlow = async (user: string, name: string) => {
            expect((await as(user)('POST', `/projects/${projectId}/flows`, { name })).status).toBe(201);
            expect((await commitAll(as(user), `add ${name}`)).status).toBe(200);
        };
        const setMode = async (mode: string) => {
            const topology = git(repo, 'show', 'flowtinus/config:topology.yaml');
            commitFiles(repo, 'flowtinus/config', { 'topology.yaml': topology.replace(/mode: [a-z-]+/, `mode: ${mode}`) }, mode);
            expect((await call('POST', '/git/reconcile')).status).toBe(200);
        };
        return { id, as, call, repo, projectId, handle, commitFlow, setMode };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-pull-request-test-'));
        gitConfig = join(dir, 'gitconfig');
        await Bun.write(gitConfig, '');
        process.env.GIT_CONFIG_GLOBAL = gitConfig;
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        if (globalBefore === undefined) {
            delete process.env.GIT_CONFIG_GLOBAL;
        } else {
            process.env.GIT_CONFIG_GLOBAL = globalBefore;
        }
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('GitHub: a compare link from the work branch into the environment, on a direct or pull-request server only', async () => {
        const { as, call, repo, handle, commitFlow, setMode } = await workspace('https://github.com/acme/flows.git');
        const branch = `users/${await handle(ANA)}/labels`;

        const onDev = await call('POST', '/git/pull-request');
        expect(onDev.status).toBe(409);
        expect(onDev.body.error.message).toContain('from a work branch into dev');

        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        const nothing = await call('POST', '/git/pull-request');
        expect(nothing.status).toBe(409);
        expect(nothing.body.error.message).toContain('dev already contains every commit');

        await commitFlow(ANA, 'Refunds');
        const opened = await call('POST', '/git/pull-request');
        expect(opened.status).toBe(200);
        expect(opened.body).toEqual({
            branch,
            target: 'dev',
            pushed: false,
            commits: 1,
            borrowed: [],
            provider: 'github',
            url: `https://github.com/acme/flows/compare/dev...${branch}?expand=1`,
        });

        expect((await as(BIA)('PUT', '/git/current-branch', { branch })).status).toBe(200);
        const notHers = await as(BIA)('POST', '/git/pull-request');
        expect(notHers.status).toBe(409);
        expect(notHers.body.error.message).toContain('not yours');

        await setMode('pull-request');
        expect((await call('POST', '/git/pull-request')).status).toBe(200);
        await setMode('protected');
        const refused = await call('POST', '/git/pull-request');
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toContain('protected');
        await setMode('direct');

        git(repo, 'update-ref', 'refs/heads/dev', git(repo, 'rev-parse', branch));
        expect((await call('POST', '/git/reconcile')).status).toBe(200);
        const listed = (await call('GET', '/git/branches')).body;
        expect(listed.mode).toBe('direct');
        expect(listed.branches.find((b: { name: string }) => b.name === branch)).toMatchObject({ merged: true });
        const merged = await call('POST', '/git/pull-request');
        expect(merged.status).toBe(409);
        expect(merged.body.error.message).toContain('it is merged');
    });

    test("GitLab: a new merge request link, which says what comes from another user's branch not yet merged", async () => {
        const { as, call, handle, commitFlow } = await workspace('https://gitlab.com/acme/team/flows.git');
        const anas = `users/${await handle(ANA)}/base`;
        expect((await call('POST', '/git/branches', { name: anas })).status).toBe(201);
        await commitFlow(ANA, 'Refunds');

        const bia = as(BIA);
        const bias = `users/${await handle(BIA)}/on-top`;
        expect((await bia('PUT', '/git/current-branch', { branch: anas })).status).toBe(200);
        expect((await bia('POST', '/git/branches', { name: bias })).status).toBe(201);
        await commitFlow(BIA, 'Returns');

        const opened = await bia('POST', '/git/pull-request');
        expect(opened.status).toBe(200);
        const query = new URLSearchParams({ 'merge_request[source_branch]': bias, 'merge_request[target_branch]': 'dev' });
        expect(opened.body).toEqual({
            branch: bias,
            target: 'dev',
            pushed: false,
            commits: 2,
            borrowed: [{ branch: anas, commits: 1 }],
            provider: 'gitlab',
            url: `https://gitlab.com/acme/team/flows/-/merge_requests/new?${query}`,
        });
        expect(opened.body.url).toContain('merge_request%5Bsource_branch%5D=users%2F');
    });

    test('a self-hosted GitLab is told by its API; another provider gets the branch pushed and no link', async () => {
        const server = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: request =>
                new URL(request.url).pathname === '/api/v4/version'
                    ? Response.json({ message: '401 Unauthorized' }, { status: 401, headers: { 'X-Gitlab-Meta': '{"version":"1"}' } })
                    : new Response('not found', { status: 404 }),
        });
        try {
            const repository = `http://127.0.0.1:${server.port}/omc/test.git`;
            const hosted = await workspace(repository);
            const branch = `users/${await hosted.handle(ANA)}/x`;
            expect((await hosted.call('POST', '/git/branches', { name: branch })).status).toBe(201);
            await hosted.commitFlow(ANA, 'Refunds');
            const opened = await hosted.call('POST', '/git/pull-request');
            expect(opened.status).toBe(200);
            expect(opened.body.provider).toBe('gitlab');
            expect(opened.body.url).toStartWith(`http://127.0.0.1:${server.port}/omc/test/-/merge_requests/new?`);
        } finally {
            await server.stop(true);
        }

        const other = await workspace(null);
        expect((await other.call('POST', '/git/branches', { name: 'fix/x' })).status).toBe(201);
        await other.commitFlow(ANA, 'Refunds');
        const opened = await other.call('POST', '/git/pull-request');
        expect(opened.status).toBe(200);
        expect(opened.body).toMatchObject({ branch: 'fix/x', target: 'dev', commits: 1, provider: null, url: null });
    });

    test('a branch removed on the remote, or a remote behind, is pushed back; one moved ahead is left as it is', async () => {
        const { call, repo, projectId, handle, commitFlow } = await workspace('https://github.com/acme/gone.git');
        const branch = `users/${await handle(ANA)}/gone`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        await commitFlow(ANA, 'Refunds');
        const tip = git(repo, 'rev-parse', branch);
        expect((await call('POST', `/projects/${projectId}/flows`, { name: 'Uncommitted' })).status).toBe(201);

        git(repo, 'update-ref', '-d', `refs/heads/${branch}`);
        expect((await call('POST', '/git/reconcile')).status).toBe(200);
        const listed = (await call('GET', '/git/branches')).body.branches;
        expect(listed.find((b: { name: string }) => b.name === branch)).toMatchObject({ removed: true });

        const opened = await call('POST', '/git/pull-request');
        expect(opened.status).toBe(200);
        expect(opened.body).toMatchObject({ branch, pushed: true, commits: 1, provider: 'github' });
        expect(git(repo, 'rev-parse', branch)).toBe(tip);
        const back = (await call('GET', '/git/branches')).body.branches.find((b: { name: string }) => b.name === branch);
        expect(back.removed).toBeUndefined();
        expect(back).toMatchObject({ editable: true });
        expect(back.changes).toBeGreaterThan(0);
        expect((await call('GET', '/git/current-branch')).body).toEqual({ branch, editable: true });

        git(repo, 'update-ref', `refs/heads/${branch}`, git(repo, 'rev-parse', 'dev'));
        const behind = await call('POST', '/git/pull-request');
        expect(behind.status).toBe(200);
        expect(behind.body).toMatchObject({ pushed: true, commits: 1 });
        expect(git(repo, 'rev-parse', branch)).toBe(tip);

        commitFiles(repo, branch, { 'notes.txt': 'from a laptop' }, 'laptop');
        const ahead = git(repo, 'rev-parse', branch);
        const moved = await call('POST', '/git/pull-request');
        expect(moved.status).toBe(200);
        expect(moved.body).toMatchObject({ pushed: false, commits: 2 });
        expect(git(repo, 'rev-parse', branch)).toBe(ahead);
    });
});
