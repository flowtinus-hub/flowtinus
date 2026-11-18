import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertMember, insertWorkspace, wsPath } from '../helpers/workspaces';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(30_000);

function git(cwd: string, ...args: string[]): string {
    const done = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (done.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')}: ${done.stderr.toString()}`);
    }

    return done.stdout.toString().trim();
}

describe("a workspace's git configuration", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function newWorkspace() {
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
        await call('POST', '/secrets', { name: 'git-token', value: 'tok3n' });
        return { id, call };
    }

    async function newRepo(name: string): Promise<{ path: string; url: string }> {
        const path = join(dir, name);
        git(dir, 'init', '--bare', '--initial-branch=main', path);
        return { path, url: pathToFileURL(path).href };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-test-'));
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('absent until an admin saves it: the repository, the secret holding the token and which environment this server is', async () => {
        const { call } = await newWorkspace();
        expect((await call('GET', '/git')).body).toEqual({ config: null, on: false });

        const config = { repository: 'https://git.example.com/acme/flows.git', tokenSecret: 'git-token', environment: 'DEV' };
        expect(await call('PUT', '/git', config)).toMatchObject({ status: 200, body: { config } });
        expect((await call('GET', '/git')).body).toEqual({ config, on: false });

        expect((await call('DELETE', '/git')).status).toBe(200);
        expect((await call('GET', '/git')).body).toEqual({ config: null, on: false });
    });

    test('HTTP(S) only, with an existing secret and an environment; only admins change it', async () => {
        const { id, call } = await newWorkspace();
        const ok = { repository: 'https://git.example.com/acme/flows.git', tokenSecret: 'git-token', environment: 'DEV' };

        for (const repository of ['git@git.example.com:acme/flows.git', 'ssh://git.example.com/acme/flows.git', 'flows', '']) {
            const refused = await call('PUT', '/git', { ...ok, repository });
            expect(refused).toMatchObject({ status: 400, body: { error: { fields: { repository: expect.any(String) } } } });
        }
        expect((await call('PUT', '/git', { ...ok, repository: 'https://user:pass@git.example.com/a.git' })).status).toBe(400);
        expect((await call('PUT', '/git', { ...ok, tokenSecret: 'nope' })).body.error.fields).toEqual({
            tokenSecret: 'No secret with this name',
        });
        expect((await call('PUT', '/git', { ...ok, environment: ' ' })).body.error.fields).toHaveProperty('environment');

        const editor = await insertMember(db, id, { role: 'editor' });
        expect((await call('PUT', '/git', ok, editor)).status).toBe(403);
        expect((await call('DELETE', '/git', undefined, editor)).status).toBe(403);
        expect((await call('GET', '/git')).body).toEqual({ config: null, on: false });
    });

    test('the access test, before saving: reads, pushes and deletes a throwaway branch, and says it does not prove a branch is protected', async () => {
        const { call } = await newWorkspace();
        const repo = await newRepo('tested.git');

        const tested = await call('POST', '/git/test', { repository: repo.url, tokenSecret: 'git-token', environment: 'DEV' });
        expect(tested).toMatchObject({
            status: 200,
            body: {
                ok: true,
                checks: [
                    { step: 'read', ok: true },
                    { step: 'write', ok: true },
                ],
                topology: { exists: false },
            },
        });
        expect(tested.body.note).toContain('not whether a given branch is protected');
        expect(git(repo.path, 'for-each-ref', 'refs/heads')).toBe('');
        expect((await call('GET', '/git')).body).toEqual({ config: null, on: false });
    });

    test('the access test says what failed: a repository it cannot reach, or an invalid configuration', async () => {
        const { call } = await newWorkspace();
        const missing = pathToFileURL(join(dir, 'missing.git')).href;

        const tested = await call('POST', '/git/test', { repository: missing, tokenSecret: 'git-token', environment: 'DEV' });
        expect(tested).toMatchObject({ status: 200, body: { ok: false, checks: [{ step: 'read', ok: false }], topology: null } });
        expect(tested.body.checks[0].message).toBeString();
        expect(tested.body.checks).toHaveLength(1);

        expect(
            (await call('POST', '/git/test', { repository: 'ssh://x/y.git', tokenSecret: 'git-token', environment: 'DEV' })).status,
        ).toBe(400);
    });

    test('over HTTP(S), the token from the secret goes to the server as basic authentication', async () => {
        const { call } = await newWorkspace();
        const seen: (string | null)[] = [];
        const server = Bun.serve({
            port: 0,
            fetch: request => {
                seen.push(request.headers.get('authorization'));
                return new Response('no', { status: 403 });
            },
        });
        try {
            const tested = await call('POST', '/git/test', {
                repository: `http://localhost:${server.port}/acme/flows.git`,
                tokenSecret: 'git-token',
                environment: 'DEV',
            });
            expect(tested.body).toMatchObject({ ok: false, checks: [{ step: 'read', ok: false }] });
            expect(seen[0]).toBe(`Basic ${btoa('oauth2:tok3n')}`);
        } finally {
            await server.stop(true);
        }
    });

    test('an empty repository gets the topology branch only once the admin confirms, with this server as a direct environment', async () => {
        const { call } = await newWorkspace();
        const repo = await newRepo('empty.git');
        expect((await call('GET', '/git/topology')).status).toBe(409);

        await call('PUT', '/git', { repository: repo.url, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('GET', '/git/topology')).body).toEqual({ topology: { exists: false } });
        expect((await call('POST', '/git/topology', {})).status).toBe(400);
        expect(git(repo.path, 'for-each-ref', 'refs/heads')).toBe('');

        const dev = { env: 'DEV', label: 'DEV', branch: 'dev', promotesTo: [], mode: 'direct' };
        const created = await call('POST', '/git/topology', { confirm: true });
        expect(created).toMatchObject({
            status: 201,
            body: { topology: { exists: true, environments: [dev], environment: dev, branchExists: false, problems: [] } },
        });
        expect(git(repo.path, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/flowtinus/config');
        expect(git(repo.path, 'show', 'flowtinus/config:topology.yaml')).toBe(
            ['environments:', '  - env: DEV', '    label: DEV', '    branch: dev', '    promotesTo: []', '    mode: direct'].join('\n'),
        );

        expect((await call('GET', '/git/topology')).body.topology).toMatchObject({ exists: true, environment: dev });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(409);
    });

    test('a topology written by anyone is read as it is, with what is wrong with it', async () => {
        const { call } = await newWorkspace();
        const repo = await newRepo('handmade.git');
        const work = join(dir, 'handmade-work');
        git(dir, 'clone', '--quiet', repo.url, work);
        git(work, 'switch', '--quiet', '--orphan', 'flowtinus/config');
        await Bun.write(
            join(work, 'topology.yaml'),
            [
                'environments:',
                '  - { env: STAGING, branch: staging, mode: protected, label: Staging }',
                '  - { env: PROD, branch: main, promotesTo: [STAGING], mode: protected }',
                '  - { env: QA, branch: qa, promotesTo: [STAGING, SANDBOX] }',
            ].join('\n'),
        );
        git(work, 'add', '.');
        git(work, '-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', 'commit', '--quiet', '-m', 'topology');
        git(work, 'push', '--quiet', 'origin', 'flowtinus/config');

        await call('PUT', '/git', { repository: repo.url, tokenSecret: 'git-token', environment: 'STAGING' });
        const { topology } = (await call('GET', '/git/topology')).body;
        expect(topology).toMatchObject({
            exists: true,
            environment: { env: 'STAGING', label: 'Staging', branch: 'staging', promotesTo: [], mode: 'protected' },
            branchExists: false,
        });
        expect(topology.environments.map((e: { env: string }) => e.env)).toEqual(['STAGING', 'PROD', 'QA']);
        expect(topology.environments[2].mode).toBe('direct');
        expect(topology.problems).toEqual([
            'STAGING has two sources (PROD, QA): the topology is a tree.',
            'QA promotes to SANDBOX, which is not declared.',
        ]);

        await call('PUT', '/git', { repository: repo.url, tokenSecret: 'git-token', environment: 'DEV' });
        expect((await call('GET', '/git/topology')).body.topology).toMatchObject({
            environment: null,
            problems: expect.arrayContaining(['DEV is not in the topology.']),
        });
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(409);
    });
});
