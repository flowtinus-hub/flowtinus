import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, BIA, insertWorkspace, slugOf, wsPath } from '../helpers/workspaces';
import { commitFiles, createBranch, git } from '../helpers/git-repos';
import { gitOptions } from '#features/git/git-config';
import { GitPoller } from '#features/git/git-poller';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

describe('a commit made with git arrives by polling and the webhook', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace(pollSeconds?: number) {
        const id = crypto.randomUUID();
        await insertWorkspace(db, id);
        const call = async (method: string, path: string, body?: unknown, user = ANA) => {
            const response = await app.request(wsPath(id, path), {
                method,
                headers: { 'x-user-id': user, 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: (await response.json()) as any };
        };
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        const config = {
            repository: pathToFileURL(repo).href,
            tokenSecret: 'git-token',
            environment: 'DEV',
            ...(pollSeconds ? { pollSeconds } : {}),
        };
        expect((await call('PUT', '/git', config)).status).toBe(200);
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);

        const show = (ref: string, file: string) =>
            Bun.spawnSync(['git', 'show', `${ref}:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        const filesOf = (ref: string): Record<string, string> =>
            Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', ref)
                    .split('\n')
                    .map(file => [file, show(ref, file)]),
            );
        const projectFile = `${slugOf(id)}/projects/Sales/project.yaml`;
        // a commit made with git: the project's description
        const describe = (description: string, branch = 'dev') => {
            const files = filesOf('dev');
            return commitFiles(
                repo,
                branch,
                { ...files, [projectFile]: files[projectFile]!.replace(/^description: .*$/m, '') + `description: ${description}\n` },
                `Describe in git`,
            );
        };
        const description = async () => (await call('GET', `/projects/${projectId}`)).body.description as string;
        const hook = async (path: string) => {
            const response = await app.request(`/${path}`, { method: 'POST', body: '{"anything": "ignored"}' });
            return { status: response.status, body: (await response.json()) as any };
        };
        return { id, call, repo, projectId, show, filesOf, describe, description, hook };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-poll-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('a commit made with git arrives within the interval', async () => {
        const { id, describe, description } = await newWorkspace(30);
        let clock = Date.now();
        const poller = new GitPoller(db, gitOptions('DEV', { clonesDir: join(dir, 'clones') }), keyring, undefined, () => clock);
        await poller.tick();
        describe('From git');

        await poller.tick();
        expect(await description()).not.toBe('From git');
        clock += 29_000;
        await poller.tick();
        expect(await description()).not.toBe('From git');
        clock += 1_000;
        await poller.tick();
        expect(await description()).toBe('From git');
        expect(
            (
                await db.query<{ value: { at: string } }>(
                    "SELECT value FROM workspace_settings WHERE workspace_id = $1 AND key = 'git-poll'",
                    [id],
                )
            )[0]!.value,
        ).toEqual({
            at: new Date(clock).toISOString(),
        });
    });

    test('the webhook brings the fetch forward at once; a wrong token is refused; more than one call in 5 s is absorbed', async () => {
        const { call, describe, description, hook } = await newWorkspace();
        const path = (await call('GET', '/git')).body.hook as string;
        expect(path).toMatch(/^git\/hook\/[a-z0-9-]+\/fgh_[A-Za-z0-9_-]{32}$/);
        expect((await call('GET', '/git', undefined, BIA)).body.hook).toBe(path);

        describe('From the webhook');
        expect(await hook(path)).toEqual({ status: 202, body: { status: 'fetching' } });
        await app.gitPoller.idle();
        expect(await description()).toBe('From the webhook');

        expect(await hook(path)).toEqual({ status: 202, body: { status: 'absorbed' } });
        expect((await hook(`${path.slice(0, -1)}${path.endsWith('x') ? 'y' : 'x'}`)).status).toBe(401);
        expect((await hook(path.replace(/\/hook\/[^/]+\//, '/hook/nowhere/'))).status).toBe(401);
    });

    test('a new token replaces the old one; removing git forgets it', async () => {
        const { call, hook } = await newWorkspace();
        const old = (await call('GET', '/git')).body.hook as string;
        const renewed = await call('POST', '/git/hook-token');
        expect(renewed.status).toBe(200);
        expect(renewed.body.hook).not.toBe(old);
        expect((await call('GET', '/git')).body.hook).toBe(renewed.body.hook);
        expect((await hook(old)).status).toBe(401);

        expect((await call('DELETE', '/git')).status).toBe(200);
        expect((await call('GET', '/git')).body.hook).toBeUndefined();
        expect((await hook(renewed.body.hook)).status).toBe(401);
    });

    test('a topology commit that moves the environment to another branch is followed and reconciled', async () => {
        const { call, repo, projectId, show, filesOf, describe, description } = await newWorkspace();
        const topology = show('flowtinus/config', 'topology.yaml');
        expect(topology).toContain('branch: dev\n');
        commitFiles(repo, 'release', filesOf('dev'));
        describe('On release', 'release');
        commitFiles(
            repo,
            'flowtinus/config',
            { 'topology.yaml': topology.replace('branch: dev\n', 'branch: release\n') },
            'Move DEV to release',
        );

        await app.gitPoller.tick(false);
        expect(await description()).toBe('On release');
        const flowId = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
        expect((await call('GET', `/flows/${flowId}/deployments`)).body.git).toEqual({ branch: 'release', mode: 'direct' });
    });

    test('an environment taken out of the topology stops reconciling, and says so', async () => {
        const { call, repo, show, describe, description } = await newWorkspace();
        const topology = show('flowtinus/config', 'topology.yaml');
        commitFiles(repo, 'flowtinus/config', { 'topology.yaml': topology.replaceAll('DEV', 'QA') }, 'Rename DEV to QA');
        describe('Never arrives');

        await app.gitPoller.tick(false);
        expect(await description()).not.toBe('Never arrives');
        expect((await call('GET', '/git')).body.lastPoll).toMatchObject({ error: 'DEV is not in the topology.' });
    });
});
