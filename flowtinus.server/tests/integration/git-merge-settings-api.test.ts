import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { fakeGitLab, type FakeGitLab } from '../helpers/fake-gitlab';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(60_000);

const TOPOLOGY = `environments:
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
  - env: PROD
    label: Production
    branch: main
    promotesTo: []
    mode: protected
`;

const SCOPES = ['api', 'read_repository', 'write_repository'];

const SQUASH = "This GitLab project forces squash: turn it off in the project's merge settings.";

const short = (sha: string) => sha.slice(0, 12);

const kinds = (body: { blocks: { kind: string }[] }) => body.blocks.map(b => b.kind);

describe("the GitLab project's merge settings, read at each check, block a promotion, a backport and a repair", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    let gitConfig: string;
    let gitlab: FakeGitLab;
    const globalBefore = process.env.GIT_CONFIG_GLOBAL;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace(token = 'with-api') {
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
        const projectId = (await call('POST', '/projects', { name: 'Sales' })).body.id as string;
        const repo = join(dir, `${id}.git`);
        git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
        createBranch(repo, 'dev');
        const path = `omc/${id}`;
        const repository = gitlab.repository(path);
        git(dir, 'config', '--file', gitConfig, '--add', `url.${pathToFileURL(repo).href}.insteadOf`, repository);
        await call('POST', '/secrets', { name: 'git-token', value: token });
        expect((await call('PUT', '/git', { repository, tokenSecret: 'git-token', environment: 'DEV' })).status).toBe(200);
        expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
        expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
        commitFiles(repo, 'flowtinus/config', { 'topology.yaml': TOPOLOGY }, 'DEV, QA and PROD');

        const show = (ref: string, file: string) =>
            Bun.spawnSync(['git', 'show', `${ref}:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
        const filesOf = (ref: string): Record<string, string> =>
            Object.fromEntries(
                git(repo, 'ls-tree', '-r', '--name-only', ref)
                    .split('\n')
                    .filter(Boolean)
                    .map(file => [file, show(ref, file)]),
            );
        const tip = (branch: string) => git(repo, 'rev-parse', branch);
        const branchAt = (branch: string, from: string) => git(repo, 'update-ref', `refs/heads/${branch}`, tip(from));
        const addFile = (branch: string, file: string) => commitFiles(repo, branch, { ...filesOf(branch), [file]: file }, `Add ${file}`);
        const commitOf = (into: string, from: string, squash: boolean) => {
            const tree = git(repo, 'merge-tree', '--write-tree', into, from);
            const who = ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com'];
            const parents = squash ? ['-p', tip(into)] : ['-p', tip(into), '-p', tip(from)];
            const commit = git(repo, ...who, 'commit-tree', tree, ...parents, '-m', `Merge ${from} into ${into}`);
            git(repo, 'update-ref', `refs/heads/${into}`, commit);
            return commit;
        };
        return {
            id,
            call,
            projectId,
            repo,
            project: gitlab.project(path),
            tip,
            branchAt,
            addFile,
            mergeInto: (into: string, from: string) => commitOf(into, from, false),
            squashInto: (into: string, from: string) => commitOf(into, from, true),
            poll: () => call('POST', '/git/reconcile'),
            preflight: (sha: string) => call('GET', `/git/promotions/preflight?target=QA&sha=${sha}`),
            promote: (sha: string) => call('POST', '/git/promotions', { target: 'QA', sha }),
            backportPreflight: () => call('GET', '/git/backports/preflight?target=QA'),
            backport: () => call('POST', '/git/backports', { target: 'QA' }),
            repair: (id: string) => call('POST', `/git/promotions/${id}/repair`),
        };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-merge-settings-test-'));
        gitConfig = join(dir, 'gitconfig');
        await Bun.write(gitConfig, '');
        process.env.GIT_CONFIG_GLOBAL = gitConfig;
        gitlab = fakeGitLab();
        gitlab.token('with-api', SCOPES);
        gitlab.token('git-only', ['read_repository', 'write_repository']);
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

    test('squash forced blocks a promotion on choosing and again on opening, read live: never cached', async () => {
        const { project, branchAt, addFile, preflight, promote } = await workspace();
        branchAt('qa', 'dev');
        const sha = addFile('dev', 'a.txt');

        expect(kinds((await preflight(sha)).body)).toEqual([]);
        project.squash_option = 'always';
        const blocked = (await preflight(sha)).body;
        expect(blocked.blocks).toEqual([{ kind: 'squash', message: SQUASH }]);

        const refused = await promote(sha);
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toBe(SQUASH);

        project.squash_option = 'default_on';
        expect(kinds((await preflight(sha)).body)).toEqual([]);
        expect((await promote(sha)).status).toBe(200);
    });

    test('squash forced blocks a backport on choosing and on opening, and a repair on opening; nothing is pushed', async () => {
        const { project, repo, tip, branchAt, addFile, squashInto, poll, promote, backportPreflight, backport, repair } = await workspace();
        branchAt('qa', 'dev');
        const sha = addFile('dev', 'a.txt');
        const promoted = (await promote(sha)).body.promotion;
        squashInto('qa', `promote/DEV-${short(sha)}`);
        await poll();
        const hotfix = addFile('qa', 'hotfix.txt');

        project.squash_option = 'always';
        expect((await backportPreflight()).body.blocks).toEqual([{ kind: 'squash', message: SQUASH }]);
        const backportRefused = await backport();
        expect(backportRefused.status).toBe(409);
        expect(backportRefused.body.error.message).toBe(SQUASH);
        expect(git(repo, 'branch', '--list', `backport/QA-${short(hotfix)}`)).toBe('');

        const repairRefused = await repair(promoted.id);
        expect(repairRefused.status).toBe(409);
        expect(repairRefused.body.error.message).toBe(SQUASH);
        expect(git(repo, 'branch', '--list', `repair/QA-${short(sha)}`)).toBe('');

        project.squash_option = 'never';
        expect((await backport()).status).toBe(200);
        expect((await repair(promoted.id)).status).toBe(200);
        expect(tip('qa')).toBe(hotfix);
    });

    test("a work branch's pull request is never blocked by the merge settings", async () => {
        const { call, projectId, project } = await workspace();
        project.squash_option = 'always';
        project.merge_method = 'ff';
        const handle = (await call('GET', '/me')).body.handle as string;
        expect((await call('POST', '/git/branches', { name: `users/${handle}/work` })).status).toBe(201);
        expect((await call('POST', `/projects/${projectId}/flows`, { name: 'Refunds' })).status).toBe(201);
        expect((await commitAll(call, 'add Refunds')).status).toBe(200);
        expect((await call('POST', '/git/pull-request')).status).toBe(200);
    });

    test('with the adapter off, the merge settings block nothing', async () => {
        const { project, branchAt, addFile, mergeInto, preflight, promote } = await workspace('git-only');
        project.squash_option = 'always';
        project.merge_method = 'ff';
        branchAt('qa', 'dev');
        addFile('dev', 'a.txt');
        mergeInto('qa', 'dev');
        const sha = addFile('dev', 'b.txt');
        expect((await preflight(sha)).body.blocks).toEqual([]);
        expect((await promote(sha)).status).toBe(200);
    });

    test('a fast-forward-only or semi-linear project blocks a promotion that needs a merge commit, not one that fast-forwards', async () => {
        for (const method of ['ff', 'rebase_merge'] as const) {
            const { project, branchAt, addFile, mergeInto, preflight, promote } = await workspace();
            project.merge_method = method;
            branchAt('qa', 'dev');
            const forward = addFile('dev', 'a.txt');
            expect((await preflight(forward)).body.blocks).toEqual([]);

            mergeInto('qa', 'dev');
            const sha = addFile('dev', 'b.txt');
            const blocks = (await preflight(sha)).body.blocks;
            expect(kinds({ blocks })).toEqual(['merge-method']);
            expect(blocks[0].message).toContain('qa cannot be fast-forwarded now: set the merge method to "Merge commit"');
            const refused = await promote(sha);
            expect(refused.status).toBe(409);
            expect(refused.body.error.message).toBe(blocks[0].message);

            project.merge_method = 'merge';
            expect((await promote(sha)).status).toBe(200);
        }
    });

    test("a fast-forward-only project allows a backport cut from the target's tip", async () => {
        const { project, tip, branchAt, addFile, backportPreflight, backport } = await workspace();
        project.merge_method = 'ff';
        branchAt('qa', 'dev');
        const hotfix = addFile('qa', 'hotfix.txt');
        addFile('dev', 'work.txt');

        expect((await backportPreflight()).body.blocks).toEqual([]);
        const opened = await backport();
        expect(opened.status).toBe(200);
        expect(opened.body.promotion).toMatchObject({ kind: 'backport', sha: hotfix });
        expect(tip('qa')).toBe(hotfix);
    });
});
