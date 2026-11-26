import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fakeGitHub, type FakeGitHub } from '../helpers/fake-github';
import { providerAdapter } from '#features/git/adapter-status';
import { API_NOTICE, ProviderError, type ProviderAdapter } from '#features/git/provider-adapter';

describe("the GitHub adapter: what it asks GitHub's API, and what it makes of the answers", () => {
    let github: FakeGitHub;

    async function adapter(repository: string, token = 'classic'): Promise<ProviderAdapter> {
        github.repo(repository);
        const status = await providerAdapter({ repository: github.repository(repository), token });
        expect(status).toMatchObject({ provider: 'github', notice: null });
        return status.adapter!;
    }

    beforeAll(() => {
        github = fakeGitHub();
        github.classic('classic', ['repo', 'workflow']);
    });

    afterAll(() => github.stop());

    test('on with a classic token with `repo` or `public_repo`, or with a fine-grained one, at the API of a GitHub Enterprise Server', async () => {
        github.classic('public', ['public_repo']);
        github.fineGrained('fine');
        for (const token of ['classic', 'public', 'fine']) {
            await adapter('omc/on', token);
            const asked = github.requests.filter(r => r.token === token).map(r => `${r.method} ${r.path} ${JSON.stringify(r.query)}`);
            expect(asked).toEqual(['GET /repos/omc/on {}', 'GET /repos/omc/on/pulls {"per_page":"1"}']);
        }
    });

    test("off with GitHub's notice without the scope, with a token that cannot read pull requests or is unknown", async () => {
        github.repo('omc/off');
        github.classic('no-scope', ['gist']);
        github.fineGrained('no-pulls', { pullRequests: 'none' });
        for (const token of ['no-scope', 'no-pulls', 'unknown']) {
            expect(await providerAdapter({ repository: github.repository('omc/off'), token })).toEqual({
                provider: 'github',
                adapter: null,
                notice: API_NOTICE.github,
            });
        }

        const missing = await providerAdapter({ repository: `${github.origin}/omc/missing.git`, token: 'classic' });
        expect(missing).toMatchObject({ provider: 'github', adapter: null });
        expect(missing.notice).toBe("GitHub's API answered 404: Not Found");

        github.fail(502);
        try {
            const down = await providerAdapter({ repository: github.repository('omc/off'), token: 'classic' });
            expect(down).toMatchObject({ provider: 'github', adapter: null });
            expect(down.notice).toStartWith("GitHub's API did not answer");
        } finally {
            github.fail(null);
        }
    });

    test('opens a pull request with the title and the description only, and says it cannot turn squash off', async () => {
        const gh = await adapter('omc/open');
        expect(gh.canTurnSquashOff).toBe(false);
        const opened = await gh.openPullRequest({
            source: 'promote/dev-abc123def456',
            target: 'qa',
            title: 'Promote DEV into QA (abc123def456)',
            description: 'Opened from Flowtinus by Ana',
            squash: false,
            removeSourceBranch: true,
        });
        expect(opened).toEqual({
            number: 1,
            url: `${github.origin}/omc/open/pull/1`,
            source: 'promote/dev-abc123def456',
            target: 'qa',
            state: 'open',
        });
        expect(github.requests.at(-1)).toEqual({
            method: 'POST',
            path: '/repos/omc/open/pulls',
            query: {},
            token: 'classic',
            body: {
                head: 'promote/dev-abc123def456',
                base: 'qa',
                title: 'Promote DEV into QA (abc123def456)',
                body: 'Opened from Flowtinus by Ana',
            },
        });
    });
    test("finds the open pull request by owner and branch, lists the open ones into a branch, reads one: never a fork's", async () => {
        const gh = await adapter('omc/find');
        const open = (source: string, target: string) =>
            gh.openPullRequest({ source, target, title: source, description: '', removeSourceBranch: true });
        github.fork('omc/find', 'stranger', 'users/ana/a', 'dev');
        await open('users/ana/a', 'dev');
        await open('users/bia/b', 'dev');
        await open('users/ana/a', 'qa');
        github.close('omc/find', 3);

        expect(await gh.findOpenPullRequest('users/ana/a', 'dev')).toMatchObject({ number: 2, state: 'open' });
        expect(github.requests.at(-1)!.query).toMatchObject({ state: 'open', head: 'omc:users/ana/a', base: 'dev' });
        expect(await gh.findOpenPullRequest('users/bia/b', 'dev')).toBeNull();
        expect((await gh.openPullRequestsInto('dev')).map(p => p.number)).toEqual([2]);
        expect((await gh.openPullRequestsInto('qa')).map(p => p.source)).toEqual(['users/ana/a']);

        expect((await gh.pullRequest(3)).state).toBe('closed');
        github.merge('omc/find', 4);
        expect(await gh.pullRequest(4)).toMatchObject({ state: 'merged', source: 'users/ana/a', target: 'qa' });
    });

    test('lists the pull requests into a branch since a date, newest first, following the link header and stopping at the first older one', async () => {
        const gh = await adapter('omc/since');
        const pulls = github.repo('omc/since').pullRequests;
        const day = (n: number) => new Date(Date.UTC(2026, 10, n)).toISOString();
        for (let n = 1; n <= 250; n++) {
            const created = await gh.openPullRequest({
                source: `users/ana/${n}`,
                target: 'qa',
                title: `${n}`,
                description: '',
                removeSourceBranch: true,
            });
            pulls.find(p => p.number === created.number)!.created_at = n <= 40 ? day(1) : day(20);
        }
        github.fork('omc/since', 'stranger', 'users/ana/250', 'qa').created_at = day(21);
        github.close('omc/since', 250);

        const before = github.requests.length;
        const listed = await gh.pullRequestsInto('qa', new Date(day(10)));
        expect(listed).toHaveLength(210);
        expect(listed[0]).toMatchObject({ number: 250, state: 'closed' });
        expect(listed.some(p => p.source === 'users/ana/40')).toBe(false);
        const pages = github.requests.slice(before);
        expect(pages.map(r => r.query.page ?? '1')).toEqual(['1', '2', '3']);
        expect(pages[0]!.query).toEqual({ state: 'all', base: 'qa', sort: 'created', direction: 'desc', per_page: '100' });
    });
    test("reads the repository's merge settings, narrowed by the rules on the target; none to a token that cannot write", async () => {
        const gh = await adapter('omc/settings');
        expect(await gh.mergeSettings('qa')).toEqual({ methods: ['merge-commit', 'squash', 'rebase'], limits: [] });
        expect(github.requests.at(-1)!.path).toBe('/repos/omc/settings/rules/branches/qa');

        github.repo('omc/settings').allow_merge_commit = false;
        expect(await gh.mergeSettings('qa')).toEqual({ methods: ['squash', 'rebase'], limits: ['merge-commits-off'] });
        github.repo('omc/settings').allow_merge_commit = true;

        github.ruleset('omc/settings', { branches: ['qa'], rules: [{ type: 'required_linear_history' }] });
        github.ruleset('omc/settings', {
            branches: ['q*'],
            rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } }],
        });
        github.ruleset('omc/settings', {
            branches: ['main'],
            rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['merge', 'rebase'] } }],
        });
        expect(await gh.mergeSettings('qa')).toEqual({
            methods: ['squash'],
            limits: ['linear-history-required', 'merge-commit-not-allowed-by-rule'],
        });
        expect(await gh.mergeSettings('main')).toEqual({ methods: ['merge-commit', 'rebase'], limits: [] });
        expect(await gh.mergeSettings('dev')).toEqual({ methods: ['merge-commit', 'squash', 'rebase'], limits: [] });

        github.fineGrained('reads-contents', { contents: 'read' });
        expect(await (await adapter('omc/settings', 'reads-contents')).mergeSettings('qa')).toBeNull();
    });

    test("answers each branch's protection from its rules, with the token's bypass, and from classic protection where readable", async () => {
        const gh = await adapter('omc/protection');
        const branches = ['main', 'qa', 'dev', 'release/1', 'free'];
        expect(await gh.branchProtections(branches)).toEqual(branches.map(branch => ({ branch, push: 'developers' })));

        github.ruleset('omc/protection', { branches: ['main'], rules: [{ type: 'update' }] });
        github.ruleset('omc/protection', {
            branches: ['qa'],
            rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['merge'] } }],
            bypass: 'always',
        });
        github.ruleset('omc/protection', { branches: ['dev'], rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] });
        github.ruleset('omc/protection', {
            branches: ['release/*'],
            rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['merge'] } }],
            bypass: 'pull_requests_only',
        });
        github.protect('omc/protection', 'free', { enforceAdmins: false });
        expect(await gh.branchProtections(branches)).toEqual([
            { branch: 'main', push: 'nobody' },
            { branch: 'qa', push: 'maintainers' },
            { branch: 'dev', push: 'developers' },
            { branch: 'release/1', push: 'nobody' },
            { branch: 'free', push: 'maintainers' },
        ]);
        expect(github.requests.filter(r => /\/rulesets\/\d+$/.test(r.path)).length).toBe(3);

        github.protect('omc/protection', 'qa');
        expect((await gh.branchProtections(['qa']))[0]!.push).toBe('nobody');
    });

    test('classic protection the token may not read is unknown on a protected branch, and nothing on an unprotected one', async () => {
        github.fineGrained('no-admin');
        const gh = await adapter('omc/classic', 'no-admin');
        github.protect('omc/classic', 'main');
        github.ruleset('omc/classic', { branches: ['qa'], rules: [{ type: 'update' }], bypass: 'always' });
        github.ruleset('omc/classic', { branches: ['prod'], rules: [{ type: 'update' }] });
        expect(await gh.branchProtections(['main', 'qa', 'prod', 'dev'])).toEqual([
            { branch: 'main', push: 'unknown' },
            { branch: 'qa', push: 'unknown' },
            { branch: 'prod', push: 'nobody' },
            { branch: 'dev', push: 'developers' },
        ]);
    });

    test("an operation GitHub refuses or fails throws a ProviderError with GitHub's status and message", async () => {
        const gh = await adapter('omc/errors');
        await gh.openPullRequest({ source: 'a', target: 'dev', title: 'a', description: '', removeSourceBranch: true });
        const duplicate = gh.openPullRequest({ source: 'a', target: 'dev', title: 'a', description: '', removeSourceBranch: true });
        await expect(duplicate).rejects.toThrow(ProviderError);
        await expect(duplicate).rejects.toMatchObject({
            status: 422,
            message: 'Validation Failed: A pull request already exists for omc:a.',
        });

        for (const status of [401, 403, 429]) {
            const restore = github.refuse('GET', /\/pulls$/, status, { message: 'API rate limit exceeded' });
            await expect(gh.openPullRequestsInto('dev')).rejects.toMatchObject({ status, message: 'API rate limit exceeded' });
            restore();
        }
        github.fail(502);
        try {
            await expect(gh.branchProtections(['main'])).rejects.toMatchObject({ status: 502 });
        } finally {
            github.fail(null);
        }
    });
});
