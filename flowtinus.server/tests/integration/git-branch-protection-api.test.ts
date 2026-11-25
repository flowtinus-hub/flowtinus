import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { fakeGitLab, type FakeGitLab } from '../helpers/fake-gitlab';
import { gitOptions } from '#features/git/git-config';
import { GitPoller } from '#features/git/git-poller';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(60_000);

const TOPOLOGY = `environments:
  - env: PROD
    label: Production
    branch: main
    promotesTo: []
    mode: protected
  - env: DEV
    label: Development
    branch: dev
    promotesTo: [QA]
    mode: direct
  - env: QA
    label: Quality
    branch: qa
    promotesTo: [PROD]
    mode: pull-request
`;

const GIT_SCOPES = ['read_repository', 'write_repository'];

const PROD_OPEN = 'Production is protected in the topology, but developers may push to main on GitLab.';
const DEV_REFUSES = 'Development is direct in the topology, but GitLab refuses pushes to dev.';

describe("the branches' protection on GitLab, where it disagrees with the topology's modes, shows as a warning", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    let gitConfig: string;
    let gitlab: FakeGitLab;
    const globalBefore = process.env.GIT_CONFIG_GLOBAL;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace(scopes = ['api', ...GIT_SCOPES]) {
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
        const path = `omc/${id}`;
        const repository = gitlab.repository(path);
        git(dir, 'config', '--file', gitConfig, '--add', `url.${pathToFileURL(repo).href}.insteadOf`, repository);
        gitlab.token(id, scopes);
        await call('POST', '/secrets', { name: 'git-token', value: id });
        expect((await call('PUT', '/git', { repository, tokenSecret: 'git-token', environment: 'DEV' })).status).toBe(200);
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        commitFiles(repo, 'flowtinus/config', { 'topology.yaml': TOPOLOGY }, 'DEV, QA and PROD');

        const warnings = async () => {
            const topology = await call('GET', '/git/topology');
            const environments = await call('GET', '/git/environments');
            expect(topology.status).toBe(200);
            expect(environments.status).toBe(200);
            return {
                section: topology.body.protection ?? [],
                cards: Object.fromEntries(environments.body.pipeline.filter((c: any) => c.warning).map((c: any) => [c.env, c.warning])),
            };
        };
        const protectionReads = () => gitlab.requests.filter(r => r.token === id && r.path.endsWith('/protected_branches')).length;
        return { id, path, call, warnings, protectionReads };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-protection-test-'));
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

    test('a protected branch only maintainers push to and an unprotected direct branch agree: no warning', async () => {
        const { path, warnings } = await workspace();
        gitlab.protect(path, 'main', { push: 40 });
        expect(await warnings()).toEqual({ section: [], cards: {} });
    });

    test("a protected environment's branch that developers may push to warns, in the git section and on its card", async () => {
        const { path, warnings } = await workspace();
        expect(await warnings()).toEqual({
            section: [{ env: 'PROD', branch: 'main', message: PROD_OPEN }],
            cards: { PROD: PROD_OPEN },
        });

        gitlab.protect(path, 'main', { push: 30 });
        expect((await warnings()).cards).toEqual({ PROD: PROD_OPEN });
    });

    test("a direct environment's branch that refuses pushes warns", async () => {
        const { path, warnings } = await workspace();
        gitlab.protect(path, 'main', { push: 40 });
        gitlab.protect(path, 'dev', { push: 0 });
        expect(await warnings()).toEqual({
            section: [{ env: 'DEV', branch: 'dev', message: DEV_REFUSES }],
            cards: { DEV: DEV_REFUSES },
        });
    });

    test('a wildcard rule protects the branches it matches; of two rules, the more permissive one decides', async () => {
        const { path, warnings } = await workspace();
        gitlab.protect(path, 'ma*', { push: 40 });
        expect((await warnings()).cards).toEqual({});

        gitlab.protect(path, '*', { push: 30 });
        expect((await warnings()).cards).toEqual({ PROD: PROD_OPEN });
    });

    test('with the adapter off nothing shows and nothing is read; an API that fails blocks nothing', async () => {
        const off = await workspace(GIT_SCOPES);
        expect(await off.warnings()).toEqual({ section: [], cards: {} });
        expect(off.protectionReads()).toBe(0);

        const on = await workspace();
        const restore = gitlab.refuse('GET', /\/protected_branches$/, 500);
        try {
            expect(await on.warnings()).toEqual({ section: [], cards: {} });
        } finally {
            restore();
        }
    });

    test('the poll never reads the protection', async () => {
        const { protectionReads } = await workspace();
        const poller = new GitPoller(db, gitOptions('DEV', { clonesDir: join(dir, 'clones') }), keyring);
        await poller.tick();
        expect(protectionReads()).toBe(0);
    });
});
