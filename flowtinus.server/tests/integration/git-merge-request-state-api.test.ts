import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { FAKE_PROVIDERS, type FakeProvider } from '../helpers/fake-providers';
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

for (const { name, make } of FAKE_PROVIDERS) {
    describe(`with the adapter on ${name}, the poll and the branch picker read the pull requests' state`, () => {
        let db: Database;
        let app: ReturnType<typeof createApp>;
        let dir: string;
        let gitConfig: string;
        let fake: FakeProvider;
        const globalBefore = process.env.GIT_CONFIG_GLOBAL;
        const keyring = new Keyring([{ version: 't', key: new Uint8Array(32).fill(7) }]);

        async function workspace() {
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
            const repository = fake.repository(path);
            git(dir, 'config', '--file', gitConfig, '--add', `url.${pathToFileURL(repo).href}.insteadOf`, repository);
            const token = `token-${id}`;
            fake.allow(token);
            await call('POST', '/secrets', { name: 'git-token', value: token });
            expect((await call('PUT', '/git', { repository, tokenSecret: 'git-token', environment: 'DEV' })).status).toBe(200);
            expect((await call('POST', '/git/topology', { confirm: true })).status).toBe(201);
            expect((await call('POST', '/git/on', { createBranch: true })).status).toBe(200);
            commitFiles(repo, 'flowtinus/config', { 'topology.yaml': TOPOLOGY }, 'DEV, QA and PROD');
            await app.gitPoller.poll(id);

            const at = (file: string) => `${workspaceHandleOf(id)}/projects/Sales/${file}`;
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
            const mergeInto = (into: string, from: string) => {
                const tree = git(repo, 'merge-tree', '--write-tree', into, from);
                const who = ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com'];
                git(
                    repo,
                    'update-ref',
                    `refs/heads/${into}`,
                    git(repo, ...who, 'commit-tree', tree, '-p', tip(into), '-p', tip(from), '-m', `Merge ${from}`),
                );
            };
            const promote = async (sha: string) => (await call('POST', '/git/promotions', { target: 'QA', sha })).body.promotion;
            const poll = () => app.gitPoller.poll(id);
            const promotions = async () => (await call('GET', '/git/environments')).body.promotions;
            const listed = () => fake.listed(path, token);
            const byHand = (source: string, target: string) => fake.byHand(path, token, source, target);
            const loseAdapter = () => fake.gitOnly(token);
            return {
                id,
                call,
                projectId,
                repo,
                path,
                at,
                tip,
                branchAt,
                write,
                mergeInto,
                promote,
                poll,
                promotions,
                listed,
                byHand,
                loseAdapter,
            };
        }

        beforeAll(async () => {
            db = await openDatabase('memory://');
            dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-merge-request-state-test-'));
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

        test('a row with no number gets it from the poll, by its branch', async () => {
            const { at, branchAt, write, promote, poll, promotions, byHand } = await workspace();
            branchAt('qa', 'dev');
            const sha = write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' });
            const allow = fake.refuseOpening(503, `${name} is restarting`);
            let opened;
            try {
                opened = await promote(sha);
            } finally {
                allow();
            }
            expect(opened).toMatchObject({ number: null });

            const pr = await byHand(`promote/DEV-${short(sha)}`, 'qa');
            await poll();
            expect(await promotions()).toEqual([{ ...opened, number: pr.number, url: pr.url }]);
        });

        test('the poll lists the pull requests opened since a day before its oldest open row: an older one on the branch is not taken', async () => {
            const { path, at, branchAt, write, promote, poll, promotions, byHand } = await workspace();
            branchAt('qa', 'dev');
            const sha = write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' });
            const branch = `promote/DEV-${short(sha)}`;
            const allow = fake.refuseOpening(503, `${name} is restarting`);
            let opened;
            try {
                opened = await promote(sha);
            } finally {
                allow();
            }

            const old = await byHand(branch, 'qa');
            fake.close(path, old.number);
            fake.openedAt(path, old.number, new Date(Date.parse(opened.openedAt) - 25 * 60 * 60 * 1000).toISOString());
            await poll();
            expect((await promotions())[0]).toMatchObject({ state: 'open', number: null });

            const recent = await byHand(branch, 'qa');
            await poll();
            expect((await promotions())[0]).toMatchObject({ state: 'open', number: recent.number, url: recent.url });
        });

        test('a pull request closed without merging makes its row closed, while its branch is still there', async () => {
            const { at, tip, branchAt, write, promote, poll, promotions, path } = await workspace();
            branchAt('qa', 'dev');
            const sha = write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' });
            const opened = await promote(sha);

            await poll();
            expect((await promotions())[0]).toMatchObject({ state: 'open', number: opened.number });

            fake.close(path, opened.number);
            await poll();
            expect(tip(opened.branch)).toBe(sha);
            expect((await promotions())[0]).toMatchObject({ state: 'closed', number: opened.number, url: null });
        });

        test('merged comes from git, never from the pull request', async () => {
            const { at, branchAt, write, mergeInto, promote, poll, promotions, path } = await workspace();
            branchAt('qa', 'dev');
            const first = await promote(write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' }));
            fake.merge(path, first.number);
            await poll();
            expect((await promotions())[0]).toMatchObject({ id: first.id, state: 'open' });

            mergeInto('qa', first.branch);
            const second = await promote(write('dev', { [at('scripts/fee.ts')]: 'export const fee = 1;\n' }));
            mergeInto('qa', second.branch);
            await poll();
            expect((await promotions()).map((p: any) => [p.id, p.state])).toEqual([
                [second.id, 'merged'],
                [first.id, 'merged'],
            ]);
        });

        test('one call per edge, only for open rows: none once nothing is open', async () => {
            const { at, branchAt, write, mergeInto, promote, poll, listed, promotions } = await workspace();
            branchAt('qa', 'dev');
            await promote(write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' }));
            await promote(write('dev', { [at('scripts/fee.ts')]: 'export const fee = 1;\n' }));

            const before = listed().length;
            await poll();
            const calls = listed().slice(before);
            expect(calls).toHaveLength(1);
            expect(calls[0]!.target).toBe('qa');

            mergeInto('qa', 'dev');
            await poll();
            const after = listed().length;
            await poll();
            expect(listed().length).toBe(after);
            expect((await promotions()).map((p: any) => p.state)).toEqual(['merged', 'merged']);
        });

        test('with the adapter lost, rows keep their numbers and their states come from git alone', async () => {
            const { at, branchAt, write, mergeInto, promote, poll, promotions, path, loseAdapter } = await workspace();
            branchAt('qa', 'dev');
            const opened = await promote(write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' }));
            loseAdapter();
            fake.close(path, opened.number);
            await poll();
            expect((await promotions())[0]).toMatchObject({ state: 'open', number: opened.number, url: opened.url });

            mergeInto('qa', opened.branch);
            await poll();
            expect((await promotions())[0]).toMatchObject({ state: 'merged', number: opened.number });
        });

        test("the branch picker shows each work branch's open pull request into the environment's branch, from one call", async () => {
            const { call, projectId, path, listed, byHand } = await workspace();
            const handle = (await call('GET', '/me')).body.handle as string;
            const open = `users/${handle}/refunds`;
            const closed = `users/${handle}/taxes`;
            for (const branch of [closed, open]) {
                expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
                expect((await call('POST', `/projects/${projectId}/flows`, { name: branch.split('/').at(-1) })).status).toBe(201);
                expect((await commitAll(call, branch)).status).toBe(200);
                expect((await call('POST', '/git/pull-request', { title: branch })).status).toBe(200);
            }
            const [first, second] = fake.pullRequests(path);
            fake.close(path, first!.number);
            await byHand(open, 'qa');

            const before = listed().length;
            const answer = await call('GET', '/git/branches');
            expect(answer.status).toBe(200);
            const calls = listed().slice(before);
            expect(calls).toHaveLength(1);
            expect(calls[0]).toEqual({ state: 'open', target: 'dev' });
            const shown = Object.fromEntries((answer.body.branches as any[]).map(b => [b.name, b.mergeRequest ?? null]));
            expect(shown).toEqual({ dev: null, [open]: { number: second!.number, url: second!.url }, [closed]: null });
        });

        test('the branch picker without the adapter shows no pull request', async () => {
            const { call, loseAdapter } = await workspace();
            loseAdapter();
            const answer = await call('GET', '/git/branches');
            expect(answer.status).toBe(200);
            expect((answer.body.branches as any[]).every(b => b.mergeRequest === undefined)).toBe(true);
        });
    });
}
