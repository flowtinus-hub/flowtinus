import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { fakeGitHub, type FakeGitHub } from '../helpers/fake-github';
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

const MERGE_COMMITS_OFF = 'This GitHub repository does not allow merge commits: turn on "Allow merge commits" in its settings.';

const LINEAR_HISTORY = 'A ruleset on qa requires a linear history: turn "Require linear history" off in the ruleset.';

const NO_MERGE_METHOD = 'A ruleset on qa does not allow merge commits: add "Merge" to the allowed merge methods of its pull request rule.';

const SQUASH_AND_REBASE =
    'This GitHub repository allows squash and rebase merges: merge this pull request with **Create a merge commit**, or the lineage breaks and needs a repair.';

const KEEPS_MERGED_BRANCHES =
    'This GitHub repository does not delete merged branches: turn on "Automatically delete head branches" in its settings (General, Pull Requests). The app never deletes a branch on the remote.';

const CLASSIC_UNREADABLE =
    'Classic branch protection cannot be read with this token, which needs admin access to the repository: the branches it protects get no warning on their protection.';

const short = (sha: string) => sha.slice(0, 12);

describe("GitHub's merge settings and rulesets block a promotion, a backport and a repair, or warn to merge with a merge commit", () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    let gitConfig: string;
    let github: FakeGitHub;
    const globalBefore = process.env.GIT_CONFIG_GLOBAL;
    const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

    async function workspace(token = 'writes') {
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
        const repository = github.repository(path);
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
        const squashInto = (into: string, from: string) => {
            const tree = git(repo, 'merge-tree', '--write-tree', into, from);
            const who = ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com'];
            const commit = git(repo, ...who, 'commit-tree', tree, '-p', tip(into), '-m', `Squash ${from} into ${into}`);
            git(repo, 'update-ref', `refs/heads/${into}`, commit);
        };
        return {
            id,
            call,
            projectId,
            repo,
            path,
            repository: github.repo(path),
            branchAt: (branch: string, from: string) => git(repo, 'update-ref', `refs/heads/${branch}`, tip(from)),
            addFile: (branch: string, file: string) => commitFiles(repo, branch, { ...filesOf(branch), [file]: file }, `Add ${file}`),
            squashInto,
            poll: () => call('POST', '/git/reconcile'),
            preflight: (sha: string) => call('GET', `/git/promotions/preflight?target=QA&sha=${sha}`),
            promote: (sha: string) => call('POST', '/git/promotions', { target: 'QA', sha }),
            backportPreflight: () => call('GET', '/git/backports/preflight?target=QA'),
            backport: () => call('POST', '/git/backports', { target: 'QA' }),
            repair: (id: string) => call('POST', `/git/promotions/${id}/repair`),
            bodies: () => github.repo(path).pullRequests.map(p => p.body),
        };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-github-merge-test-'));
        gitConfig = join(dir, 'gitconfig');
        await Bun.write(gitConfig, '');
        process.env.GIT_CONFIG_GLOBAL = gitConfig;
        github = fakeGitHub();
        github.fineGrained('writes');
        github.fineGrained('reads', { contents: 'read' });
        app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
    });

    afterAll(async () => {
        if (globalBefore === undefined) {
            delete process.env.GIT_CONFIG_GLOBAL;
        } else {
            process.env.GIT_CONFIG_GLOBAL = globalBefore;
        }
        await github.stop();
        await db.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('merge commits turned off on the repository block a promotion on choosing and on opening, even one that fast-forwards', async () => {
        const { repository, branchAt, addFile, preflight, promote, bodies } = await workspace();
        branchAt('qa', 'dev');
        const sha = addFile('dev', 'a.txt');
        repository.allow_merge_commit = false;

        expect((await preflight(sha)).body.blocks).toEqual([{ kind: 'merge-method', message: MERGE_COMMITS_OFF }]);
        const refused = await promote(sha);
        expect(refused.status).toBe(409);
        expect(refused.body.error.message).toBe(MERGE_COMMITS_OFF);
        expect(bodies()).toEqual([]);

        repository.allow_merge_commit = true;
        expect((await promote(sha)).status).toBe(200);
    });

    test('a ruleset on the target with linear history, or a pull request rule without merge, blocks a backport and a repair; nothing is pushed', async () => {
        const { path, repo, repository, branchAt, addFile, squashInto, poll, promote, backportPreflight, backport, repair } =
            await workspace();
        branchAt('qa', 'dev');
        const sha = addFile('dev', 'a.txt');
        const promoted = (await promote(sha)).body.promotion;
        squashInto('qa', `promote/DEV-${short(sha)}`);
        await poll();
        const hotfix = addFile('qa', 'hotfix.txt');

        github.ruleset(path, { branches: ['dev'], rules: [{ type: 'required_linear_history' }] });
        github.ruleset(path, { branches: ['qa'], rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }] });
        const intoDev = LINEAR_HISTORY.replace('on qa', 'on dev');
        expect((await backportPreflight()).body.blocks).toEqual([{ kind: 'merge-method', message: intoDev }]);
        const backportRefused = await backport();
        expect(backportRefused.status).toBe(409);
        expect(backportRefused.body.error.message).toBe(intoDev);
        expect(git(repo, 'branch', '--list', `backport/QA-${short(hotfix)}`)).toBe('');

        const repairRefused = await repair(promoted.id);
        expect(repairRefused.status).toBe(409);
        expect(repairRefused.body.error.message).toBe(NO_MERGE_METHOD);
        expect(git(repo, 'branch', '--list', `repair/QA-${short(sha)}`)).toBe('');

        repository.rulesets = [];
        expect((await backport()).status).toBe(200);
        expect((await repair(promoted.id)).status).toBe(200);
    });

    test("a work branch's pull request is never blocked, and its description carries no warning", async () => {
        const { call, projectId, repository, bodies } = await workspace();
        repository.allow_merge_commit = false;
        const handle = (await call('GET', '/me')).body.handle as string;
        expect((await call('POST', '/git/branches', { name: `users/${handle}/work` })).status).toBe(201);
        expect((await call('POST', `/projects/${projectId}/flows`, { name: 'Refunds' })).status).toBe(201);
        expect((await commitAll(call, 'add Refunds')).status).toBe(200);
        expect((await call('POST', '/git/pull-request')).status).toBe(200);
        expect(bodies()).toHaveLength(1);
        expect(bodies()[0]).not.toContain('squash');
    });

    test('where squash or rebase is allowed, the promotion, backport and repair warn beside the checks, and their descriptions open with it', async () => {
        const { repository, branchAt, addFile, squashInto, poll, preflight, promote, backportPreflight, backport, repair, bodies } =
            await workspace();
        const warning = { kind: 'merge-method', message: SQUASH_AND_REBASE, items: [] };
        branchAt('qa', 'dev');
        const sha = addFile('dev', 'a.txt');
        expect((await preflight(sha)).body.warnings).toEqual([warning]);
        const promoted = (await promote(sha)).body.promotion;
        squashInto('qa', `promote/DEV-${short(sha)}`);
        await poll();
        addFile('qa', 'hotfix.txt');

        expect((await backportPreflight()).body.warnings).toEqual([warning]);
        expect((await backport()).status).toBe(200);
        const repaired = await repair(promoted.id);
        expect(repaired.status).toBe(200);
        expect(repaired.body.warnings).toEqual([warning]);
        expect(bodies()).toHaveLength(3);
        for (const body of bodies()) {
            expect(body).toStartWith(`${SQUASH_AND_REBASE}
`);
            expect(body.split(SQUASH_AND_REBASE)).toHaveLength(2);
        }

        repository.allow_squash_merge = false;
        expect((await preflight(addFile('dev', 'b.txt'))).body.warnings).toEqual([warning]);
        repository.allow_rebase_merge = false;
        expect((await preflight(addFile('dev', 'c.txt'))).body.warnings).toEqual([]);
    });

    test("the git section's topology says the repository keeps merged branches and that classic protection is unreadable; the cards do not", async () => {
        const { path, call, repository } = await workspace();
        const notices = async () => {
            const topology = await call('GET', '/git/topology');
            expect(topology.status).toBe(200);
            return topology.body.notices ?? [];
        };
        expect(await notices()).toEqual([KEEPS_MERGED_BRANCHES]);

        github.protect(path, 'qa');
        expect(await notices()).toEqual([KEEPS_MERGED_BRANCHES, CLASSIC_UNREADABLE]);
        const environments = await call('GET', '/git/environments');
        expect(environments.status).toBe(200);
        expect(JSON.stringify(environments.body)).not.toContain('merged branches');
        expect(JSON.stringify(environments.body)).not.toContain('Classic branch protection');

        repository.delete_branch_on_merge = true;
        expect(await notices()).toEqual([CLASSIC_UNREADABLE]);
        repository.classic = {};
        expect(await notices()).toEqual([]);
    });

    test('a token that cannot read the setting gets no notice on merged branches', async () => {
        const { call } = await workspace('reads');
        expect((await call('GET', '/git/topology')).body.notices).toBeUndefined();
    });

    test('settings the token cannot read block nothing and warn of nothing', async () => {
        const { repository, branchAt, addFile, preflight, promote, bodies } = await workspace('reads');
        repository.allow_merge_commit = false;
        branchAt('qa', 'dev');
        const sha = addFile('dev', 'a.txt');
        const checked = (await preflight(sha)).body;
        expect(checked.blocks).toEqual([]);
        expect(checked.warnings).toEqual([]);
        expect((await promote(sha)).status).toBe(200);
        expect(bodies()[0]).not.toContain(SQUASH_AND_REBASE);
    });
});
