import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANA, insertWorkspace, workspaceHandleOf, wsPath } from '../helpers/workspaces';
import { commitAll, commitFiles, createBranch, git } from '../helpers/git-repos';
import { fakeGitLab, type FakeGitLab } from '../helpers/fake-gitlab';
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

const SCOPES = ['api', 'read_repository', 'write_repository'];

const short = (sha: string) => sha.slice(0, 12);

describe('with the adapter on, the app opens its pull requests as GitLab merge requests', () => {
    let db: Database;
    let app: ReturnType<typeof createApp>;
    let dir: string;
    let gitConfig: string;
    let gitlab: FakeGitLab;
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
        const repository = gitlab.repository(path);
        git(dir, 'config', '--file', gitConfig, '--add', `url.${pathToFileURL(repo).href}.insteadOf`, repository);
        const token = options.token ?? `token-${id}`;
        gitlab.token(token, SCOPES);
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
        const project = () => gitlab.project(path);
        const posted = () => gitlab.requests.filter(r => r.method === 'POST' && r.path === `/projects/${path}/merge_requests`);
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
            squashInto,
            commitFlow,
            userHandle,
            project,
            posted,
            promotions,
        };
    }

    beforeAll(async () => {
        db = await openDatabase('memory://');
        dir = await mkdtemp(join(tmpdir(), 'flowtinus-git-merge-requests-test-'));
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

    test("a work branch's: the title given, the project's squash, the source branch removed; an open one is linked, a closed one is not", async () => {
        const { call, at, commitFlow, userHandle, project, posted } = await workspace();
        const branch = `users/${await userHandle()}/refunds`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        await commitFlow('Refunds');

        const opened = await call('POST', '/git/pull-request', { title: 'Refunds for the orders' });
        expect(opened.status).toBe(200);
        const [mr] = project().mergeRequests;
        expect(opened.body).toMatchObject({
            branch,
            target: 'dev',
            provider: 'gitlab',
            url: mr!.web_url,
            mergeRequest: { number: 1, url: mr!.web_url },
        });
        expect(opened.body.notice).toBeUndefined();
        const { description, ...sent } = posted()[0]!.body;
        expect(sent).toEqual({ source_branch: branch, target_branch: 'dev', title: 'Refunds for the orders', remove_source_branch: true });
        expect(description).toContain(at('flows/Refunds.flow.yaml'));
        expect(description).toContain('Refunds: added');
        expect(description).toEndWith('Opened from Flowtinus by Ana.');
        expect(mr).toMatchObject({ squash: false, force_remove_source_branch: true });

        const again = await call('POST', '/git/pull-request', { title: 'Another title' });
        expect(again.body).toMatchObject({ url: mr!.web_url, mergeRequest: { number: 1 } });
        expect(project().mergeRequests).toHaveLength(1);

        gitlab.close(project().path, 1);
        const reopened = await call('POST', '/git/pull-request', {});
        expect(reopened.body.mergeRequest.number).toBe(2);
        expect(project().mergeRequests.map(m => [m.iid, m.state, m.title])).toEqual([
            [1, 'closed', 'Refunds for the orders'],
            [2, 'opened', branch],
        ]);
    });

    test('a promotion: squash off, its fixed title, the checks in the description; its row keeps the number and link', async () => {
        const { call, path, at, branchAt, write, project, posted, promotions } = await workspace();
        branchAt('qa', 'dev');
        const sha = write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' });
        const branch = `promote/DEV-${short(sha)}`;

        const opened = await call('POST', '/git/promotions', { target: 'QA', sha });
        expect(opened.status).toBe(200);
        const [mr] = project().mergeRequests;
        const { description, ...sent } = posted()[0]!.body;
        expect(sent).toEqual({
            source_branch: branch,
            target_branch: 'qa',
            title: `Promote DEV into QA (${short(sha)})`,
            squash: false,
            remove_source_branch: true,
        });
        expect(description).toContain(`- added \`${at('scripts/tax.ts')}\``);
        expect(description).toEndWith('Opened from Flowtinus by Ana.');
        expect(opened.body.notice).toBeUndefined();
        expect(opened.body.promotion).toMatchObject({ branch, state: 'open', number: 1, url: mr!.web_url });
        expect(await promotions()).toEqual([opened.body.promotion]);

        const again = await call('POST', '/git/promotions', { target: 'QA', sha });
        expect(again.body).toMatchObject({ reused: true, promotion: { id: opened.body.promotion.id, number: 1 } });
        expect(project().mergeRequests).toHaveLength(1);

        gitlab.close(path, 1);
        const after = await call('POST', '/git/promotions', { target: 'QA', sha });
        expect(after.status).toBe(200);
        expect(after.body).toMatchObject({ reused: false, promotion: { branch, state: 'open', number: 2 } });
        expect(project().mergeRequests.map(m => [m.iid, m.state, m.source_branch])).toEqual([
            [1, 'closed', branch],
            [2, 'opened', branch],
        ]);
        expect((await promotions()).map((p: any) => [p.number, p.state])).toEqual([
            [2, 'open'],
            [1, 'closed'],
        ]);
    });

    test('a backport: squash off, its fixed title into the source; after a closed one, a new merge request and row on its branch', async () => {
        const { call, path, at, tip, branchAt, write, project, posted, promotions } = await workspace();
        branchAt('qa', 'dev');
        const hotfix = write('qa', { [at('scripts/hotfix.ts')]: 'export const fix = 1;\n' });
        write('dev', { 'work.txt': 'work' });
        const branch = `backport/QA-${short(hotfix)}`;

        const opened = await call('POST', '/git/backports', { target: 'QA' });
        expect(opened.status).toBe(200);
        const { description, ...sent } = posted()[0]!.body;
        expect(sent).toEqual({
            source_branch: branch,
            target_branch: 'dev',
            title: `Backport QA into DEV (${short(hotfix)})`,
            squash: false,
            remove_source_branch: true,
        });
        expect(description).toContain(`- added \`${at('scripts/hotfix.ts')}\``);
        expect(description).toEndWith('Opened from Flowtinus by Ana.');
        const [mr] = project().mergeRequests;
        expect(opened.body.promotion).toMatchObject({ kind: 'backport', branch, number: 1, url: mr!.web_url });

        const pushed = tip(branch);
        gitlab.close(path, 1);
        const after = await call('POST', '/git/backports', { target: 'QA' });
        expect(after.status).toBe(200);
        expect(after.body).toMatchObject({ reused: false, promotion: { branch, number: 2 } });
        expect(tip(branch)).toBe(pushed);
        expect((await promotions()).map((p: any) => [p.number, p.state])).toEqual([
            [2, 'open'],
            [1, 'closed'],
        ]);
    });

    test('a repair: squash off, its fixed title; an open one is linked, a closed one is opened again', async () => {
        const { call, path, at, branchAt, write, squashInto, project, posted } = await workspace();
        branchAt('qa', 'dev');
        const sha = write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' });
        const promoted = await call('POST', '/git/promotions', { target: 'QA', sha });
        squashInto('qa', promoted.body.promotion.branch);
        expect((await call('POST', '/git/reconcile')).status).toBe(200);
        const id = promoted.body.promotion.id;
        const branch = `repair/QA-${short(sha)}`;

        const repaired = await call('POST', `/git/promotions/${id}/repair`);
        expect(repaired.status).toBe(200);
        const mr = project().mergeRequests.find(m => m.source_branch === branch)!;
        const { description, ...sent } = posted().at(-1)!.body;
        expect(sent).toEqual({
            source_branch: branch,
            target_branch: 'qa',
            title: `Repair the lineage of ${short(sha)} into QA`,
            squash: false,
            remove_source_branch: true,
        });
        expect(description).toEndWith('Opened from Flowtinus by Ana.');
        expect(repaired.body).toMatchObject({ branch, reused: false, url: mr.web_url, mergeRequest: { number: mr.iid, url: mr.web_url } });

        const again = await call('POST', `/git/promotions/${id}/repair`);
        expect(again.body).toMatchObject({ reused: true, mergeRequest: { number: mr.iid } });
        gitlab.close(path, mr.iid);
        const reopened = await call('POST', `/git/promotions/${id}/repair`);
        expect(reopened.body.mergeRequest.number).toBe(mr.iid + 1);
        expect(
            project()
                .mergeRequests.filter(m => m.source_branch === branch)
                .map(m => m.state),
        ).toEqual(['closed', 'opened']);
    });

    test("a hotfix's: the title given, the project's squash, into the protected environment's branch", async () => {
        const { call, at, projectId, project, posted } = await workspace({ topology: TOPOLOGY.replace('mode: direct', 'mode: protected') });
        expect((await call('GET', '/git/status')).body.mode).toBe('protected');
        expect((await call('POST', '/git/hotfix', { name: 'urgent' })).status).toBe(201);
        const script = { kind: 'script', path: 'fix.ts', content: 'export const fix = 1;\n' };
        expect((await call('POST', `/projects/${projectId}/scripts`, script)).status).toBe(201);
        expect((await commitAll(call, 'Fix')).status).toBe(200);

        const opened = await call('POST', '/git/pull-request', { title: 'Urgent fix' });
        expect(opened.status).toBe(200);
        const { description, ...sent } = posted()[0]!.body;
        expect(sent).toEqual({ source_branch: 'hotfix/urgent', target_branch: 'dev', title: 'Urgent fix', remove_source_branch: true });
        expect(description).toContain(at('scripts/fix.ts'));
        expect(opened.body).toMatchObject({
            branch: 'hotfix/urgent',
            mergeRequest: { number: 1, url: project().mergeRequests[0]!.web_url },
        });
    });

    test('a failure after the push keeps it: the new pull request link, the error named, the row written with no number', async () => {
        const { call, path, at, tip, branchAt, write, promotions } = await workspace();
        branchAt('qa', 'dev');
        const sha = write('dev', { [at('scripts/tax.ts')]: 'export const tax = 1;\n' });
        const branch = `promote/DEV-${short(sha)}`;

        const allow = gitlab.refuse('POST', /\/merge_requests$/, 503, { message: 'GitLab is restarting' });
        try {
            const opened = await call('POST', '/git/promotions', { target: 'QA', sha });
            expect(opened.status).toBe(200);
            expect(tip(branch)).toBe(sha);
            expect(opened.body.notice).toBe("The merge request was not opened: GitLab's API did not answer: GitLab is restarting");
            const query = new URLSearchParams({ 'merge_request[source_branch]': branch, 'merge_request[target_branch]': 'qa' });
            expect(opened.body.promotion).toMatchObject({
                branch,
                number: null,
                url: `${gitlab.origin}/${path}/-/merge_requests/new?${query}`,
            });
            expect(await promotions()).toEqual([opened.body.promotion]);
        } finally {
            allow();
        }

        const retried = await call('POST', '/git/promotions', { target: 'QA', sha });
        expect(retried.body).toMatchObject({ reused: true, promotion: { number: 1, url: gitlab.project(path).mergeRequests[0]!.web_url } });
        expect((await promotions())[0]).toMatchObject({ number: 1 });
    });

    test('with the adapter off (no `api` scope), the branch is pushed and linked as before, and no merge request is asked for', async () => {
        const { call, path, userHandle, commitFlow } = await workspace({ token: 'git-only' });
        gitlab.token('git-only', ['read_repository', 'write_repository']);
        const branch = `users/${await userHandle()}/x`;
        expect((await call('POST', '/git/branches', { name: branch })).status).toBe(201);
        await commitFlow('Refunds');

        const opened = await call('POST', '/git/pull-request', { title: 'Ignored' });
        expect(opened.status).toBe(200);
        const query = new URLSearchParams({ 'merge_request[source_branch]': branch, 'merge_request[target_branch]': 'dev' });
        expect(opened.body).toEqual({
            branch,
            target: 'dev',
            pushed: false,
            commits: 1,
            borrowed: [],
            provider: 'gitlab',
            url: `${gitlab.origin}/${path}/-/merge_requests/new?${query}`,
        });
        expect(gitlab.requests.some(r => r.token === 'git-only' && r.path.includes('/merge_requests'))).toBe(false);
    });
});
