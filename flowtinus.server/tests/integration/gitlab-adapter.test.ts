import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { fakeGitLab, type FakeGitLab } from '../helpers/fake-gitlab';
import { providerAdapter } from '#features/git/adapter-status';
import { API_NOTICE, ProviderError, type ProviderAdapter } from '#features/git/provider-adapter';

describe("the GitLab adapter: what it asks GitLab's API, and what it makes of the answers", () => {
    let gitlab: FakeGitLab;

    async function adapter(project: string, token = 'tok3n'): Promise<ProviderAdapter> {
        const status = await providerAdapter({ repository: gitlab.repository(project), token });
        expect(status).toMatchObject({ provider: 'gitlab', notice: null });
        return status.adapter!;
    }

    beforeAll(() => {
        gitlab = fakeGitLab();
        gitlab.token('tok3n', ['api', 'read_repository', 'write_repository']);
    });

    afterAll(() => gitlab.stop());

    test('opens a pull request with the title, description, squash off and the source branch removed on merge', async () => {
        const gl = await adapter('omc/open');
        const opened = await gl.openPullRequest({
            source: 'promote/dev-abc123def456',
            target: 'qa',
            title: 'Promote DEV into QA (abc123def456)',
            description: 'Opened from Flowtinus by Ana',
            squash: false,
            removeSourceBranch: true,
        });
        expect(opened).toEqual({
            number: 1,
            url: `${gitlab.origin}/omc/open/-/merge_requests/1`,
            source: 'promote/dev-abc123def456',
            target: 'qa',
            state: 'open',
        });
        expect(gitlab.requests.at(-1)).toEqual({
            method: 'POST',
            path: '/projects/omc/open/merge_requests',
            query: {},
            token: 'tok3n',
            body: {
                source_branch: 'promote/dev-abc123def456',
                target_branch: 'qa',
                title: 'Promote DEV into QA (abc123def456)',
                description: 'Opened from Flowtinus by Ana',
                remove_source_branch: true,
                squash: false,
            },
        });

        await gl.openPullRequest({ source: 'users/ana/x', target: 'dev', title: 'x', description: '', removeSourceBranch: true });
        expect(gitlab.requests.at(-1)!.body).not.toHaveProperty('squash');
        gitlab.project('omc/open').squash_option = 'default_on';
        await gl.openPullRequest({ source: 'users/ana/y', target: 'dev', title: 'y', description: '', removeSourceBranch: true });
        expect(gitlab.project('omc/open').mergeRequests.map(m => m.squash)).toEqual([false, false, true]);
    });

    test('finds the open pull request from a branch into a target, lists the open ones into a branch, reads one', async () => {
        const gl = await adapter('omc/find');
        const open = (source: string, target: string) =>
            gl.openPullRequest({ source, target, title: source, description: '', removeSourceBranch: true });
        await open('users/ana/a', 'dev');
        await open('users/bia/b', 'dev');
        await open('users/ana/a', 'qa');
        gitlab.close('omc/find', 2);

        expect(await gl.findOpenPullRequest('users/ana/a', 'dev')).toMatchObject({ number: 1, state: 'open' });
        expect(await gl.findOpenPullRequest('users/bia/b', 'dev')).toBeNull();
        expect((await gl.openPullRequestsInto('dev')).map(p => p.number)).toEqual([1]);
        expect((await gl.openPullRequestsInto('qa')).map(p => p.source)).toEqual(['users/ana/a']);

        expect((await gl.pullRequest(2)).state).toBe('closed');
        gitlab.merge('omc/find', 3);
        expect((await gl.pullRequest(3)).state).toBe('merged');
    });

    test("reads the project's merge settings as the methods allowed into a target, and says it can turn squash off", async () => {
        const gl = await adapter('omc/settings');
        expect(gl.canTurnSquashOff).toBe(true);
        expect(await gl.mergeSettings('qa')).toEqual({ methods: ['merge-commit', 'squash'], limits: [] });

        const project = gitlab.project('omc/settings');
        project.squash_option = 'always';
        project.merge_method = 'ff';
        expect(await gl.mergeSettings('qa')).toEqual({ methods: ['squash'], limits: ['squash-forced', 'fast-forward-only'] });
        project.squash_option = 'never';
        project.merge_method = 'rebase_merge';
        expect(await gl.mergeSettings('qa')).toEqual({ methods: ['fast-forward'], limits: ['semi-linear-only'] });
        project.squash_option = 'always';
        project.merge_method = 'merge';
        expect(await gl.mergeSettings('qa')).toEqual({ methods: ['squash'], limits: ['squash-forced'] });
    });

    test("answers the protection of the branches asked for, matching the project's patterns, the most permissive one winning", async () => {
        const gl = await adapter('omc/protection');
        const branches = ['main', 'dev', 'qa', 'release/1'];
        expect(await gl.branchProtections(branches)).toEqual(branches.map(branch => ({ branch, push: 'developers' })));

        gitlab.protect('omc/protection', 'main', { push: 0, merge: 40 });
        gitlab.protect('omc/protection', 'dev', { push: 30, merge: 30 });
        gitlab.protect('omc/protection', 'release/*', { push: 40 });
        gitlab.protect('omc/protection', 'release/1', { push: 0 });
        expect(await gl.branchProtections(branches)).toEqual([
            { branch: 'main', push: 'nobody' },
            { branch: 'dev', push: 'developers' },
            { branch: 'qa', push: 'developers' },
            { branch: 'release/1', push: 'maintainers' },
        ]);
    });

    test("an operation GitLab refuses or fails throws a ProviderError with GitLab's status and message", async () => {
        const gl = await adapter('omc/errors');
        await gl.openPullRequest({ source: 'a', target: 'dev', title: 'a', description: '', removeSourceBranch: true });
        const duplicate = gl.openPullRequest({ source: 'a', target: 'dev', title: 'a', description: '', removeSourceBranch: true });
        await expect(duplicate).rejects.toThrow(ProviderError);
        await expect(duplicate).rejects.toMatchObject({ status: 409, message: expect.stringContaining('!1') });

        const restore = gitlab.refuse('GET', /\/protected_branches$/, 403, { message: '403 Forbidden' });
        await expect(gl.branchProtections(['main'])).rejects.toMatchObject({ status: 403, message: '403 Forbidden' });
        restore();
        expect(await gl.branchProtections(['main'])).toEqual([{ branch: 'main', push: 'developers' }]);

        gitlab.fail(502);
        try {
            await expect(gl.mergeSettings('qa')).rejects.toMatchObject({ status: 502 });
        } finally {
            gitlab.fail(null);
        }
    });

    test('off with the notice when the token lacks the `api` scope, is unknown, or the project is not there', async () => {
        gitlab.token('read-only', ['read_api', 'read_repository']);
        for (const token of ['read-only', 'unknown']) {
            expect(await providerAdapter({ repository: gitlab.repository('omc/off'), token })).toEqual({
                provider: 'gitlab',
                adapter: null,
                notice: API_NOTICE.gitlab,
            });
        }

        const missing = await providerAdapter({ repository: `${gitlab.origin}/omc/missing.git`, token: 'tok3n' });
        expect(missing).toMatchObject({ provider: 'gitlab', adapter: null });
        expect(missing.notice).toContain('404 Project Not Found');
    });

    test('a self-hosted GitLab that answers a 5xx at its first probe is told again once it answers, not kept as another provider', async () => {
        const down = fakeGitLab();
        try {
            down.token('tok3n', ['api', 'read_repository', 'write_repository']);
            down.fail(502);
            expect(await providerAdapter({ repository: down.repository('omc/later'), token: 'tok3n' })).toEqual({
                provider: null,
                adapter: null,
                notice: null,
            });
            down.fail(null);
            expect(await providerAdapter({ repository: down.repository('omc/later'), token: 'tok3n' })).toMatchObject({
                provider: 'gitlab',
                notice: null,
            });
        } finally {
            await down.stop();
        }
    });
});
