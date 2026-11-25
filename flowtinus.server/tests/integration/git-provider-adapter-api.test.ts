import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { createBranch, git } from '../helpers/git-repos';
import { fakeGitLab, type FakeGitLab } from '../helpers/fake-gitlab';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(60_000);

const API_NOTICE = 'The API is not reachable with this token: add the `api` scope to use the adapter.';

const GIT_SCOPES = ['read_repository', 'write_repository'];

describe('the provider adapter turns on by itself on a GitLab remote whose token can use the API', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    let gitConfig: string;
    let gitlab: FakeGitLab;
    const globalBefore = process.env.GIT_CONFIG_GLOBAL;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace(token: string, options: { on?: boolean; repository?: string } = {}) {
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
        createBranch(repo, 'dev');
        const repository = options.repository ?? gitlab.repository(`omc/${id}`);
        if (!options.repository) {
            git(dir, 'config', '--file', gitConfig, '--add', `url.${pathToFileURL(repo).href}.insteadOf`, repository);
        }
        await call('POST', '/secrets', { name: 'git-token', value: token });
        const config = { repository, tokenSecret: 'git-token', environment: 'DEV' };
        expect((await call('PUT', '/git', config)).status).toBe(200);
        if (options.on ?? true) {
            expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
            expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        }
        return { id, call, config, repo };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-adapter-test-'));
        gitConfig = join(dir, 'gitconfig');
        await Bun.write(gitConfig, '');
        process.env.GIT_CONFIG_GLOBAL = gitConfig;
        gitlab = fakeGitLab();
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        if (globalBefore === undefined) {
            delete process.env.GIT_CONFIG_GLOBAL;
        } else {
            process.env.GIT_CONFIG_GLOBAL = globalBefore;
        }
        await gitlab.stop();
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('the access test also calls the API: an `api` token passes it, one without says what scope to add and git still works', async () => {
        gitlab.token('with-api', ['api', ...GIT_SCOPES]);
        gitlab.token('git-only', GIT_SCOPES);

        const withApi = await workspace('with-api', { on: false });
        const passed = await withApi.call('POST', '/git/test', withApi.config);
        expect(passed.status).toBe(200);
        expect(passed.body.ok).toBe(true);
        expect(passed.body.checks.map((c: any) => [c.step, c.ok])).toEqual([
            ['read', true],
            ['write', true],
            ['api', true],
        ]);
        expect(gitlab.requests.filter(r => r.token === 'with-api').map(r => r.path)).toContain('/personal_access_tokens/self');

        const gitOnly = await workspace('git-only', { on: false });
        const refused = await gitOnly.call('POST', '/git/test', gitOnly.config);
        expect(refused.status).toBe(200);
        expect(refused.body.ok).toBe(true);
        expect(refused.body.checks.at(-1)).toEqual({ step: 'api', ok: false, message: API_NOTICE });
    });

    test('a remote that is not GitLab has no API check and no adapter', async () => {
        const id = crypto.randomUUID();
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        const local = await workspace('plain', { repository: pathToFileURL(repo).href });
        const tested = await local.call('POST', '/git/test', local.config);
        expect(tested.body.checks.map((c: any) => c.step)).toEqual(['read', 'write']);
        expect((await local.call('GET', '/git')).body.adapter).toBeUndefined();
    });

    test("the git section shows the adapter on with an `api` token, and the access test's notice while it is off", async () => {
        gitlab.token('section-api', ['api', ...GIT_SCOPES]);
        gitlab.token('section-git', GIT_SCOPES);

        const on = await workspace('section-api');
        expect((await on.call('GET', '/git')).body.adapter).toEqual({ provider: 'gitlab', on: true });

        const off = await workspace('section-git');
        expect((await off.call('GET', '/git')).body.adapter).toEqual({ provider: 'gitlab', on: false, notice: API_NOTICE });
    });

    test('an API that stops answering, or a scope removed, turns the adapter off by itself; it comes back with the API', async () => {
        gitlab.token('flaky', ['api', ...GIT_SCOPES]);
        const { call } = await workspace('flaky');
        expect((await call('GET', '/git')).body.adapter).toEqual({ provider: 'gitlab', on: true });

        gitlab.fail(503);
        try {
            const down = (await call('GET', '/git')).body;
            expect(down.on).toBe(true);
            expect(down.adapter).toMatchObject({ provider: 'gitlab', on: false });
            expect(down.adapter.notice).toStartWith("GitLab's API did not answer");
        } finally {
            gitlab.fail(null);
        }
        expect((await call('GET', '/git')).body.adapter).toEqual({ provider: 'gitlab', on: true });

        gitlab.token('flaky', GIT_SCOPES);
        expect((await call('GET', '/git')).body.adapter).toEqual({ provider: 'gitlab', on: false, notice: API_NOTICE });
        gitlab.token('flaky', ['read_api', ...GIT_SCOPES]);
        expect((await call('GET', '/git')).body.adapter).toEqual({ provider: 'gitlab', on: false, notice: API_NOTICE });
    });
});
