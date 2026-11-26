import type { Provider } from '#features/git/pull-request';
import { fakeGitHub } from './fake-github';
import { fakeGitLab } from './fake-gitlab';

export type FakePullRequest = {
    number: number;
    source: string;
    target: string;
    title: string;
    state: 'open' | 'closed' | 'merged';
    url: string;
};

export type SentPullRequest = { source: string; target: string; title: string; description: string; extra: Record<string, unknown> };

export type FakeProvider = {
    provider: Provider;
    name: string;
    pullRequestName: string;
    origin: string;
    repository(path: string): string;
    allow(token: string): void;
    gitOnly(token: string): void;
    pullRequests(path: string): FakePullRequest[];
    sent(path: string): SentPullRequest[];
    listed(path: string, token: string): { target: string | undefined; state: string | undefined }[];
    askedForPullRequests(token: string): boolean;
    close(path: string, number: number): void;
    merge(path: string, number: number): void;
    openedAt(path: string, number: number, at: string): void;
    refuseOpening(status: number, message: string): () => void;
    byHand(path: string, token: string, source: string, target: string): Promise<{ number: number; url: string }>;
    newPullRequestLink(path: string, source: string, target: string): string;
    stop(): Promise<void>;
};

const GITLAB_STATE = { opened: 'open', closed: 'closed', merged: 'merged' } as const;

const GIT_SCOPES = ['read_repository', 'write_repository'];

function gitlabProvider(): FakeProvider {
    const gitlab = fakeGitLab();
    const mergeRequests = (path: string) => `/projects/${path}/merge_requests`;
    return {
        provider: 'gitlab',
        name: 'GitLab',
        pullRequestName: 'merge request',
        origin: gitlab.origin,
        repository: path => gitlab.repository(path),
        allow: token => gitlab.token(token, ['api', ...GIT_SCOPES]),
        gitOnly: token => gitlab.token(token, GIT_SCOPES),
        pullRequests: path =>
            gitlab.project(path).mergeRequests.map(m => ({
                number: m.iid,
                source: m.source_branch,
                target: m.target_branch,
                title: m.title,
                state: GITLAB_STATE[m.state],
                url: m.web_url,
            })),
        sent: path =>
            gitlab.requests
                .filter(r => r.method === 'POST' && r.path === mergeRequests(path))
                .map(({ body: { source_branch, target_branch, title, description, ...extra } }) => ({
                    source: source_branch,
                    target: target_branch,
                    title,
                    description,
                    extra,
                })),
        listed: (path, token) =>
            gitlab.requests
                .filter(r => r.method === 'GET' && r.path === mergeRequests(path) && r.token === token)
                .map(r => ({ target: r.query.target_branch, state: r.query.state === 'opened' ? 'open' : r.query.state })),
        askedForPullRequests: token => gitlab.requests.some(r => r.token === token && r.path.includes('/merge_requests')),
        close: (path, number) => gitlab.close(path, number),
        merge: (path, number) => gitlab.merge(path, number),
        openedAt: (path, number, at) => {
            gitlab.project(path).mergeRequests.find(m => m.iid === number)!.created_at = at;
        },
        refuseOpening: (status, message) => gitlab.refuse('POST', /\/merge_requests$/, status, { message }),
        byHand: async (path, token, source, target) => {
            const response = await fetch(`${gitlab.origin}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`, {
                method: 'POST',
                headers: { 'private-token': token, 'content-type': 'application/json' },
                body: JSON.stringify({ source_branch: source, target_branch: target, title: 'By hand' }),
            });
            const { iid, web_url } = (await response.json()) as { iid: number; web_url: string };
            return { number: iid, url: web_url };
        },
        newPullRequestLink: (path, source, target) =>
            `${gitlab.origin}/${path}/-/merge_requests/new?${new URLSearchParams({ 'merge_request[source_branch]': source, 'merge_request[target_branch]': target })}`,
        stop: () => gitlab.stop(),
    };
}

function githubProvider(): FakeProvider {
    const github = fakeGitHub();
    const pulls = (path: string) => `/repos/${path}/pulls`;
    return {
        provider: 'github',
        name: 'GitHub',
        pullRequestName: 'pull request',
        origin: github.origin,
        repository: path => github.repository(path),
        allow: token => github.classic(token, ['repo', 'workflow']),
        gitOnly: token => github.classic(token, []),
        pullRequests: path =>
            github.repo(path).pullRequests.map(p => ({
                number: p.number,
                source: p.head.ref,
                target: p.base.ref,
                title: p.title,
                state: p.state === 'open' ? 'open' : p.merged_at ? 'merged' : 'closed',
                url: p.html_url,
            })),
        sent: path =>
            github.requests
                .filter(r => r.method === 'POST' && r.path === pulls(path))
                .map(({ body: { head, base, title, body, ...extra } }) => ({
                    source: head,
                    target: base,
                    title,
                    description: body,
                    extra,
                })),
        listed: (path, token) =>
            github.requests
                .filter(r => r.method === 'GET' && r.path === pulls(path) && r.token === token && r.query.per_page !== '1')
                .map(r => ({ target: r.query.base, state: r.query.state })),
        askedForPullRequests: token =>
            github.requests.some(r => r.token === token && r.path.includes('/pulls') && r.query.per_page !== '1'),
        close: (path, number) => github.close(path, number),
        merge: (path, number) => github.merge(path, number),
        openedAt: (path, number, at) => {
            github.repo(path).pullRequests.find(p => p.number === number)!.created_at = at;
        },
        refuseOpening: (status, message) => github.refuse('POST', /\/pulls$/, status, { message }),
        byHand: async (path, token, source, target) => {
            const response = await fetch(`${github.origin}/api/v3/repos/${path}/pulls`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ head: source, base: target, title: 'By hand' }),
            });
            const { number, html_url } = (await response.json()) as { number: number; html_url: string };
            return { number, url: html_url };
        },
        newPullRequestLink: (path, source, target) => `${github.origin}/${path}/compare/${target}...${source}?expand=1`,
        stop: () => github.stop(),
    };
}

export const FAKE_PROVIDERS: { name: string; make: () => FakeProvider }[] = [
    { name: 'GitLab', make: gitlabProvider },
    { name: 'GitHub', make: githubProvider },
];
