import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { FAKE_PROVIDERS, type FakeProvider } from '../helpers/fake-providers';
import { API_NOTICE } from '#features/git/provider-adapter';
import { Keyring } from '#shared/crypto/keyring';
import { openDatabase, type Database } from '#shared/database/database';
import { createApp } from '../../api/app';

setDefaultTimeout(120_000);

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

const short = (sha: string) => sha.slice(0, 12);

// what each provider is sent besides the branches, the title and the description: GitHub has neither squash nor removing the branch on a pull request
const EXTRA = {
    GitLab: { workBranch: { remove_source_branch: true }, keepingCommits: { squash: false, remove_source_branch: true } },
    GitHub: { workBranch: {}, keepingCommits: {} },
} as Record<string, Record<'workBranch' | 'keepingCommits', Record<string, unknown>>>;

for (const { name, make } of FAKE_PROVIDERS) {
    describe(`with the adapter on, the app opens its pull requests on ${name}`, () => {
        let db: Database;
        let app: ReturnType<typeof createApp>;
        let dir: string;
        let gitConfig: string;
        let fake: FakeProvider;
        const extra = EXTRA[name]!;
        const globalBefore = process.env.GIT_CONFIG_GLOBAL;
        const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

        async function workspace(options: { token?: string; topology?: string } = {}) {
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
            const orders = (await call('POST', `/projects/${projectId}/flows`, { name: 'Orders' })).body.id as string;
            expect((await call('POST', `/flows/${orders}/deploy`)).status).toBe(200);
            const repo = join(dir, `${id}.git`);
            git(dir, 'init', '--bare', '--quiet', '--initial-branch=main', repo);
            createBranch(repo, 'dev');
            const path = `omc/${id}`;
            const repository = fake.repository(path);
            git(dir, 'config', '--file', gitConfig, '--add', `url.${pathToFileURL(repo).href}.insteadOf`, repository);
            const token = options.token ?? `token-${id}`;
            fake.allow(token);
            await call('POST', '/secrets', { name: 'git-token', value: token });
            expect((await call('PUT', '/git', { repository, tokenSecret: 'git-token', environment: 'DEV' })).status).toBe(200);
            expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
            expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
            commitFiles(repo, 'flowtinus/config', { 'topology.yaml': options.topology ?? TOPOLOGY }, 'DEV, QA and PROD');
            await app.gitPoller.poll(id);

            const handle = workspaceHandleOf(id);
            const at = (file: string) => `${handle}/projects/Sales/${file}`;
            const tip = (branch: string) => git(repo, 'rev-parse', branch);
            const show = (ref: string, file: string) =>
                Bun.spawnSync(['git', 'show', `${ref}:${file}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
            const filesOf = (ref: string): Record<string, string> =>
                Object.fromEntries(
                    git(repo, 'ls-tree', '-r', '--name-only', ref)
                        .split('\n')
                        .filter(Boolean)
                        .map(file => [file, show(ref, file)]),
                );
            const branchAt = (branch: string, from: string) => git(repo, 'update-ref', `refs/heads/${branch}`, tip(from));
            const write = (branch: string, files: Record<string, string>) =>
                commitFiles(repo, branch, { ...filesOf(branch), ...files }, `Change ${Object.keys(files).join(', ')}`);
            const remove = (branch: string, file: string) => {
                const { [file]: _, ...rest } = filesOf(branch);
                return commitFiles(repo, branch, rest, `Remove ${file}`);
            };
            const squashInto = (into: string, from: string) => {
                const tree = git(repo, 'merge-tree', '--write-tree', into, from);
                const who = ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com'];
                const commit = git(repo, ...who, 'commit-tree', tree, '-p', tip(into), '-m', `Squash ${from} into ${into}`);
                git(repo, 'update-ref', `refs/heads/${into}`, commit);
                return commit;
            };
            const commitFlow = async (name: string) => {
                expect((await call('POST', `/projects/${projectId}/flows`, { name })).status).toBe(201);
                expect((await commitAll(call, `add ${name}`)).status).toBe(200);
            };
            const userHandle = async () => (await call('GET', '/me')).body.handle as string;
            const pullRequests = () => fake.pullRequests(path);
            const sent = () => fake.sent(path);
            const promotions = async () => (await call('GET', '/git/environments')).body.promotions;
            return {
                id,
                call,
                repo,
                projectId,
                path,
                at,
                tip,
                branchAt,
                write,
                remove,
                squashInto,
                commitFlow,
                userHandle,
                pullRequests,
                sent,
                promotions,
            };
        }

        beforeAll(async () => {
            db = await openDatabase('memory://');
            dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-merge-requests-test-'));
            gitConfig = join(dir, 'gitconfig');
            await Bun.write(gitConfig, '');
            process.env.GIT_CONFIG_GLOBAL = gitConfig;
            fake = make();
            app = createApp(db, 'DEV', keyring, undefined, { git: { clonesDir: join(dir, 'clones') } });
        });

        afterAll(async () => {
            if (globalBefore === undefined) {
                delete process.env.GIT_CONFIG_GLOBAL;
            } else {
                process.env.GIT_CONFIG_GLOBAL = globalBefore;
            }
            await fake.stop();
            await db.close();
            await rm(dir, { recursive: true, force: true });
        });

        test("a work branch's: the title given, nothing about squash; an open one is linked, a closed one is not", async () => {
            const { call, path, at, commitFlow, userHandle, pullRequests, sent } = await workspace();
            const branch = `users/${await userHandle()}/refunds`;
            expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
            await commitFlow('Refunds');

            const opened = await call('POST', '/git/pull-request', { title: 'Refunds for the orders' });
            expect(opened.status).toBe(200);
            const [pr] = pullRequests();
            expect(opened.body).toMatchObject({
                branch,
                target: 'dev',
                provider: fake.provider,
                url: pr!.url,
                mergeRequest: { number: 1, url: pr!.url },
            });
            expect(opened.body.notice).toBeUndefined();
            const { description, ...rest } = sent()[0]!;
            expect(rest).toEqual({ source: branch, target: 'dev', title: 'Refunds for the orders', extra: extra.workBranch });
            expect(description).toContain(at('flows/Refunds.flow.yaml'));
            expect(description).toContain('Refunds: added');
            expect(description).toEndWith('Opened from Flowtinus by Ana.');

            const again = await call('POST', '/git/pull-request', { title: 'Another title' });
            expect(again.body).toMatchObject({ url: pr!.url, mergeRequest: { number: 1 } });
            expect(pullRequests()).toHaveLength(1);

            fake.close(path, 1);
            const reopened = await call('POST', '/git/pull-request', {});
            expect(reopened.body.mergeRequest.number).toBe(2);
            expect(pullRequests().map(p => [p.number, p.state, p.title])).toEqual([
                [1, 'closed', 'Refunds for the orders'],
                [2, 'open', branch],
            ]);
        });

        test('a promotion: kept from squashing where the provider can, its fixed title, the checks in the description; its row keeps the number and link', async () => {
            const { call, path, at, branchAt, write, pullRequests, sent, promotions } = await workspace();
            branchAt('qa', 'dev');
            const sha = write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' });
            const branch = `promote/DEV-${short(sha)}`;

            const opened = await call('POST', '/git/promotions', { target: 'QA', sha });
            expect(opened.status).toBe(200);
            const [pr] = pullRequests();
            const { description, ...rest } = sent()[0]!;
            expect(rest).toEqual({
                source: branch,
                target: 'qa',
                title: `Promote DEV into QA (${short(sha)})`,
                extra: extra.keepingCommits,
            });
            expect(description).toContain(`- added \`${at('scripts/tax.ts')}\``);
            expect(description).toEndWith('Opened from Flowtinus by Ana.');
            expect(opened.body.notice).toBeUndefined();
            expect(opened.body.promotion).toMatchObject({ branch, state: 'open', number: 1, url: pr!.url });
            expect(await promotions()).toEqual([opened.body.promotion]);

            const again = await call('POST', '/git/promotions', { target: 'QA', sha });
            expect(again.body).toMatchObject({ reused: true, promotion: { id: opened.body.promotion.id, number: 1 } });
            expect(pullRequests()).toHaveLength(1);

            fake.close(path, 1);
            const after = await call('POST', '/git/promotions', { target: 'QA', sha });
            expect(after.status).toBe(200);
            expect(after.body).toMatchObject({ reused: false, promotion: { branch, state: 'open', number: 2 } });
            expect(pullRequests().map(p => [p.number, p.state, p.source])).toEqual([
                [1, 'closed', branch],
                [2, 'open', branch],
            ]);
            expect((await promotions()).map((p: any) => [p.number, p.state])).toEqual([
                [2, 'open'],
                [1, 'closed'],
            ]);
        });

        test('a backport: kept from squashing where the provider can, its fixed title into the source; after a closed one, a new pull request and row on its branch', async () => {
            const { call, path, at, tip, branchAt, write, pullRequests, sent, promotions } = await workspace();
            branchAt('qa', 'dev');
            const hotfix = write('qa', { [at('scripts/hotfix.ts')]: 'export const fix = 1;\n' });
            write('dev', { 'work.txt': 'work' });
            const branch = `backport/QA-${short(hotfix)}`;

            const opened = await call('POST', '/git/backports', { target: 'QA' });
            expect(opened.status).toBe(200);
            const { description, ...rest } = sent()[0]!;
            expect(rest).toEqual({
                source: branch,
                target: 'dev',
                title: `Backport QA into DEV (${short(hotfix)})`,
                extra: extra.keepingCommits,
            });
            expect(description).toContain(`- added \`${at('scripts/hotfix.ts')}\``);
            expect(description).toEndWith('Opened from Flowtinus by Ana.');
            const [pr] = pullRequests();
            expect(opened.body.promotion).toMatchObject({ kind: 'backport', branch, number: 1, url: pr!.url });

            const pushed = tip(branch);
            fake.close(path, 1);
            const after = await call('POST', '/git/backports', { target: 'QA' });
            expect(after.status).toBe(200);
            expect(after.body).toMatchObject({ reused: false, promotion: { branch, number: 2 } });
            expect(tip(branch)).toBe(pushed);
            expect((await promotions()).map((p: any) => [p.number, p.state])).toEqual([
                [2, 'open'],
                [1, 'closed'],
            ]);
        });

        test("a backport's description names its impact on the flows", async () => {
            const { call, at, branchAt, write, remove, sent } = await workspace();
            branchAt('qa', 'dev');
            remove('qa', at('flows/Orders.flow.yaml'));
            write('dev', { 'work.txt': 'work' });

            expect((await call('POST', '/git/backports', { target: 'QA' })).status).toBe(200);
            expect(sent()[0]!.description).toContain('### Flows\n\n- Sales/Orders: removed');
        });

        test("a work branch's description carries the warnings of its checks", async () => {
            const { call, at, projectId, write, sent } = await workspace({ topology: TOPOLOGY.replace('mode: direct', 'mode: protected') });
            expect((await call('POST', '/git/hotfix', { name: 'urgent' })).status).toBe(201);
            const script = { kind: 'script', path: 'fix.ts', content: 'export const fix = 1;\n' };
            expect((await call('POST', `/projects/${projectId}/scripts`, script)).status).toBe(201);
            expect((await commitAll(call, 'Fix')).status).toBe(200);
            write('hotfix/urgent', { [at('notes.txt')]: 'stray' });

            expect((await call('POST', '/git/pull-request', {})).status).toBe(200);
            expect(sent()[0]!.description).toContain(
                `### Warnings\n\n- ${at('notes.txt')}: It is not part of the repository format: it is left out.`,
            );
        });

        test('a repair: kept from squashing where the provider can, its fixed title; an open one is linked, a closed one is opened again', async () => {
            const { call, path, at, branchAt, write, squashInto, pullRequests, sent } = await workspace();
            branchAt('qa', 'dev');
            const sha = write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' });
            const promoted = await call('POST', '/git/promotions', { target: 'QA', sha });
            squashInto('qa', promoted.body.promotion.branch);
            expect((await call('POST', '/git/reconcile')).status).toBe(200);
            const id = promoted.body.promotion.id;
            const branch = `repair/QA-${short(sha)}`;

            const repaired = await call('POST', `/git/promotions/${id}/repair`);
            expect(repaired.status).toBe(200);
            const pr = pullRequests().find(p => p.source === branch)!;
            const { description, ...rest } = sent().at(-1)!;
            expect(rest).toEqual({
                source: branch,
                target: 'qa',
                title: `Repair the lineage of ${short(sha)} into QA`,
                extra: extra.keepingCommits,
            });
            expect(description).toEndWith('Opened from Flowtinus by Ana.');
            expect(repaired.body).toMatchObject({ branch, reused: false, url: pr.url, mergeRequest: { number: pr.number, url: pr.url } });

            const again = await call('POST', `/git/promotions/${id}/repair`);
            expect(again.body).toMatchObject({ reused: true, mergeRequest: { number: pr.number } });
            fake.close(path, pr.number);
            const reopened = await call('POST', `/git/promotions/${id}/repair`);
            expect(reopened.body.mergeRequest.number).toBe(pr.number + 1);
            expect(
                pullRequests()
                    .filter(p => p.source === branch)
                    .map(p => p.state),
            ).toEqual(['closed', 'open']);
        });

        test("a hotfix's: the title given, into the protected environment's branch", async () => {
            const { call, at, projectId, pullRequests, sent } = await workspace({
                topology: TOPOLOGY.replace('mode: direct', 'mode: protected'),
            });
            expect((await call('GET', '/git/status')).body.mode).toBe('protected');
            expect((await call('POST', '/git/hotfix', { name: 'urgent' })).status).toBe(201);
            const script = { kind: 'script', path: 'fix.ts', content: 'export const fix = 1;\n' };
            expect((await call('POST', `/projects/${projectId}/scripts`, script)).status).toBe(201);
            expect((await commitAll(call, 'Fix')).status).toBe(200);

            const opened = await call('POST', '/git/pull-request', { title: 'Urgent fix' });
            expect(opened.status).toBe(200);
            const { description, ...rest } = sent()[0]!;
            expect(rest).toEqual({ source: 'hotfix/urgent', target: 'dev', title: 'Urgent fix', extra: extra.workBranch });
            expect(description).toContain(at('scripts/fix.ts'));
            expect(opened.body).toMatchObject({ branch: 'hotfix/urgent', mergeRequest: { number: 1, url: pullRequests()[0]!.url } });
        });

        test('a 5xx or a 403 after the push keeps it: the new pull request link, the error named, the row written with no number', async () => {
            const { call, path, at, tip, branchAt, write, pullRequests, promotions } = await workspace();
            branchAt('qa', 'dev');
            const sha = write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' });
            const branch = `promote/DEV-${short(sha)}`;

            const allow = fake.refuseOpening(503, `${name} is restarting`);
            try {
                const opened = await call('POST', '/git/promotions', { target: 'QA', sha });
                expect(opened.status).toBe(200);
                expect(tip(branch)).toBe(sha);
                expect(opened.body.notice).toBe(
                    `The ${fake.pullRequestName} was not opened: ${name}'s API did not answer: ${name} is restarting`,
                );
                expect(opened.body.promotion).toMatchObject({ branch, number: null, url: fake.newPullRequestLink(path, branch, 'qa') });
                expect(await promotions()).toEqual([opened.body.promotion]);
            } finally {
                allow();
            }
            const refuse = fake.refuseOpening(403, 'Resource not accessible by personal access token');
            try {
                const refused = await call('POST', '/git/promotions', { target: 'QA', sha });
                expect(refused.body).toMatchObject({
                    reused: true,
                    notice: `The ${fake.pullRequestName} was not opened: ${API_NOTICE[fake.provider]}`,
                });
                expect(refused.body.promotion).toMatchObject({ number: null });
            } finally {
                refuse();
            }

            const retried = await call('POST', '/git/promotions', { target: 'QA', sha });
            expect(retried.body).toMatchObject({ reused: true, promotion: { number: 1, url: pullRequests()[0]!.url } });
            expect((await promotions())[0]).toMatchObject({ number: 1 });
        });

        test('with the adapter off (the git scopes only), the branch is pushed and linked as before, and no pull request is asked for', async () => {
            const { call, path, userHandle, commitFlow } = await workspace({ token: 'git-only' });
            fake.gitOnly('git-only');
            const branch = `users/${await userHandle()}/x`;
            expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
            await commitFlow('Refunds');

            const opened = await call('POST', '/git/pull-request', { title: 'Ignored' });
            expect(opened.status).toBe(200);
            expect(opened.body).toEqual({
                branch,
                target: 'dev',
                pushed: false,
                commits: 1,
                borrowed: [],
                provider: fake.provider,
                url: fake.newPullRequestLink(path, branch, 'dev'),
            });
            expect(fake.askedForPullRequests('git-only')).toBe(false);
        });
    });
}
