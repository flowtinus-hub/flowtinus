import type { FakeRoute, RecordedRequest } from './fake-gitlab';

export type GitHubPullRequest = {
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    merged_at: string | null;
    head: { ref: string; label: string; repo: { full_name: string } | null };
    base: { ref: string };
    html_url: string;
    created_at: string;
};

export type GitHubMergeMethod = 'merge' | 'squash' | 'rebase';

export type GitHubRule =
    | { type: 'update' | 'required_linear_history' | 'deletion' | 'non_fast_forward' }
    | { type: 'pull_request'; parameters: { allowed_merge_methods: GitHubMergeMethod[] } };

export type GitHubBypass = 'always' | 'pull_requests_only' | 'never';

export type GitHubRuleset = { id: number; name: string; branches: string[]; rules: GitHubRule[]; bypass: GitHubBypass };

export type GitHubRepository = {
    full_name: string;
    private: boolean;
    allow_merge_commit: boolean;
    allow_squash_merge: boolean;
    allow_rebase_merge: boolean;
    delete_branch_on_merge: boolean;
    rulesets: GitHubRuleset[];
    classic: Record<string, { enforce_admins: boolean }>;
    pullRequests: GitHubPullRequest[];
};

type Level = 'none' | 'read' | 'write';

export type GitHubToken =
    { kind: 'classic'; scopes: string[] } | { kind: 'fine-grained'; contents: Level; pullRequests: Level; administration: Level };

export type FakeGitHub = {
    origin: string;
    repository(path: string): string;
    repo(path: string): GitHubRepository;
    classic(token: string, scopes: string[]): void;
    fineGrained(token: string, permissions?: Partial<Omit<Extract<GitHubToken, { kind: 'fine-grained' }>, 'kind'>>): void;
    requests: RecordedRequest[];
    fail(status: number | null): void;
    refuse(method: string, path: RegExp, status: number, message?: unknown): () => void;
    close(path: string, number: number): void;
    merge(path: string, number: number): void;
    fork(path: string, owner: string, branch: string, base: string): GitHubPullRequest;
    ruleset(path: string, ruleset: { branches: string[]; rules: GitHubRule[]; bypass?: GitHubBypass; name?: string }): number;
    protect(path: string, branch: string, options?: { enforceAdmins?: boolean }): void;
    deniesProtectionWith(status: 403 | 404): () => void;
    route(handler: FakeRoute): void;
    stop(): Promise<void>;
};

const NOT_ACCESSIBLE = { message: 'Resource not accessible by personal access token', status: '403' };

const pattern = (glob: string) =>
    new RegExp(
        `^${glob
            .split('*')
            .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]*')}$`,
    );

const atLeast = (level: Level, wanted: Exclude<Level, 'none'>) => level === 'write' || level === wanted;

export function fakeGitHub(): FakeGitHub {
    const repositories = new Map<string, GitHubRepository>();
    const tokens = new Map<string, GitHubToken>();
    const requests: RecordedRequest[] = [];
    const routes: FakeRoute[] = [];
    const refusals: { method: string; path: RegExp; status: number; message: unknown }[] = [];
    let failing: number | null = null;
    let nextRuleset = 1;
    let protectionDenied: 403 | 404 = 403;
    let origin = '';

    const repo = (path: string): GitHubRepository => {
        const key = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
        let found = repositories.get(key);
        if (!found) {
            found = {
                full_name: key,
                private: false,
                allow_merge_commit: true,
                allow_squash_merge: true,
                allow_rebase_merge: true,
                delete_branch_on_merge: false,
                rulesets: [],
                classic: {},
                pullRequests: [],
            };
            repositories.set(key, found);
        }
        return found;
    };

    const pullRequest = (r: GitHubRepository, number: number) => {
        const found = r.pullRequests.find(p => p.number === number);
        if (!found) {
            throw new Error(`No pull request #${number} in ${r.full_name}`);
        }
        return found;
    };

    const canWrite = (token: GitHubToken, r: GitHubRepository) =>
        token.kind === 'classic'
            ? token.scopes.includes('repo') || (!r.private && token.scopes.includes('public_repo'))
            : token.contents === 'write';

    const pullRequestAccess = (token: GitHubToken, r: GitHubRepository, wanted: 'read' | 'write') =>
        token.kind === 'classic' ? wanted === 'read' || canWrite(token, r) : atLeast(token.pullRequests, wanted);

    const rulesOf = (r: GitHubRepository, branch: string) =>
        r.rulesets
            .filter(s => s.branches.some(b => pattern(b).test(branch)))
            .flatMap(s =>
                s.rules.map(rule => ({ ...rule, ruleset_source_type: 'Repository', ruleset_source: r.full_name, ruleset_id: s.id })),
            );

    function page<T>(items: T[], url: URL, headers: Record<string, string>): Response {
        const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 30), 100);
        const at = Number(url.searchParams.get('page') ?? 1);
        const slice = items.slice((at - 1) * perPage, at * perPage);
        if (at * perPage < items.length) {
            const next = new URL(url);
            next.searchParams.set('page', String(at + 1));
            headers = { ...headers, link: `<${next.href}>; rel="next"` };
        }
        return Response.json(slice, { headers });
    }

    function builtIn(method: string, path: string, url: URL, body: any, token: GitHubToken, headers: Record<string, string>): Response {
        const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
        const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
        const r = match ? repositories.get(match[1]!) : undefined;
        if (!match || !r || (r.private && token.kind === 'classic' && !token.scopes.includes('repo'))) {
            return json({ message: 'Not Found', status: '404' }, 404);
        }
        const rest = match[2] ?? '';
        const query = url.searchParams;

        if (method === 'GET' && rest === '') {
            const {
                rulesets: _,
                classic: __,
                pullRequests: ___,
                allow_merge_commit,
                allow_squash_merge,
                allow_rebase_merge,
                delete_branch_on_merge,
                ...shown
            } = r;
            const settings = { allow_merge_commit, allow_squash_merge, allow_rebase_merge, delete_branch_on_merge };
            return json({ ...shown, name: r.full_name.split('/')[1], ...(canWrite(token, r) ? settings : {}) });
        }
        if (rest === '/pulls' || rest.startsWith('/pulls/')) {
            if (!pullRequestAccess(token, r, method === 'GET' ? 'read' : 'write')) {
                return json(NOT_ACCESSIBLE, 403);
            }
        }
        if (method === 'GET' && rest === '/pulls') {
            const state = query.get('state') ?? 'open';
            const listed = r.pullRequests
                .filter(
                    p =>
                        (state === 'all' || p.state === state) &&
                        (!query.get('head') || p.head.label === query.get('head')) &&
                        (!query.get('base') || p.base.ref === query.get('base')),
                )
                .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number);
            if ((query.get('direction') ?? 'desc') === 'desc') {
                listed.reverse();
            }
            return page(listed, url, headers);
        }
        const one = /^\/pulls\/(\d+)$/.exec(rest);
        if (method === 'GET' && one) {
            const found = r.pullRequests.find(p => p.number === Number(one[1]));
            return found ? json(found) : json({ message: 'Not Found', status: '404' }, 404);
        }
        if (method === 'POST' && rest === '/pulls') {
            if (!body?.title || !body?.head || !body?.base) {
                return json(
                    { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'missing_field' }], status: '422' },
                    422,
                );
            }
            const owner = r.full_name.split('/')[0];
            const label = String(body.head).includes(':') ? String(body.head) : `${owner}:${body.head}`;
            if (r.pullRequests.some(p => p.state === 'open' && p.head.label === label && p.base.ref === body.base)) {
                return json(
                    {
                        message: 'Validation Failed',
                        errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${label}.` }],
                        status: '422',
                    },
                    422,
                );
            }
            const number = r.pullRequests.length + 1;
            const created: GitHubPullRequest = {
                number,
                title: body.title,
                body: body.body ?? '',
                state: 'open',
                merged_at: null,
                head: { ref: label.split(':')[1]!, label, repo: { full_name: r.full_name } },
                base: { ref: body.base },
                html_url: `${origin}/${r.full_name}/pull/${number}`,
                created_at: new Date().toISOString(),
            };
            r.pullRequests.push(created);
            return json(created, 201);
        }
        const rules = /^\/rules\/branches\/(.+)$/.exec(rest);
        if (method === 'GET' && rules) {
            return page(rulesOf(r, rules[1]!), url, headers);
        }
        const ruleset = /^\/rulesets\/(\d+)$/.exec(rest);
        if (method === 'GET' && ruleset) {
            const found = r.rulesets.find(s => s.id === Number(ruleset[1]));
            return found
                ? json({ id: found.id, name: found.name, target: 'branch', enforcement: 'active', current_user_can_bypass: found.bypass })
                : json({ message: 'Not Found', status: '404' }, 404);
        }
        const protection = /^\/branches\/(.+)\/protection$/.exec(rest);
        if (method === 'GET' && protection) {
            if (token.kind === 'fine-grained' ? token.administration === 'none' : !token.scopes.includes('repo')) {
                return protectionDenied === 403 ? json(NOT_ACCESSIBLE, 403) : json({ message: 'Not Found', status: '404' }, 404);
            }
            const classic = r.classic[protection[1]!];
            return classic
                ? json({ url: url.href, enforce_admins: { enabled: classic.enforce_admins }, required_linear_history: { enabled: false } })
                : json({ message: 'Branch not protected', status: '404' }, 404);
        }
        const branch = /^\/branches\/(.+)$/.exec(rest);
        if (method === 'GET' && branch) {
            const name = branch[1]!;
            return json({ name, protected: !!r.classic[name] || rulesOf(r, name).length > 0 });
        }
        return json({ message: 'Not Found', status: '404' }, 404);
    }

    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async request => {
            const url = new URL(request.url);
            const headers: Record<string, string> = { 'x-github-request-id': crypto.randomUUID() };
            if (url.pathname === '/api/v3/meta') {
                return Response.json({ verifiable_password_authentication: false }, { headers });
            }
            if (!url.pathname.startsWith('/api/v3/')) {
                return new Response('not found', { status: 404 });
            }
            const path = decodeURIComponent(url.pathname.slice('/api/v3'.length));
            const value = request.headers.get('authorization')?.replace(/^(Bearer|token) /, '') ?? null;
            const text = await request.text();
            const body = text ? JSON.parse(text) : undefined;
            requests.push({ method: request.method, path, query: Object.fromEntries(url.searchParams), body, token: value });

            if (failing !== null) {
                return new Response('GitHub is not responding', { status: failing });
            }
            const token = value === null ? undefined : tokens.get(value);
            if (token?.kind === 'classic') {
                headers['x-oauth-scopes'] = token.scopes.join(', ');
            }
            const refusal = refusals.find(r => r.method === request.method && r.path.test(path));
            if (refusal) {
                return Response.json(refusal.message, { status: refusal.status, headers });
            }
            if (!token) {
                return Response.json({ message: 'Bad credentials', status: '401' }, { status: 401, headers });
            }
            for (const route of routes) {
                const answer = await route({ method: request.method, path, query: url.searchParams, body, token: value! });
                if (answer) {
                    return answer;
                }
            }
            return builtIn(request.method, path, url, body, token, headers);
        },
    });
    origin = `http://127.0.0.1:${server.port}`;

    return {
        origin,
        repository: path => `${origin}/${repo(path).full_name}.git`,
        repo,
        classic: (value, scopes) => void tokens.set(value, { kind: 'classic', scopes }),
        fineGrained: (value, permissions = {}) =>
            void tokens.set(value, {
                kind: 'fine-grained',
                contents: 'write',
                pullRequests: 'write',
                administration: 'none',
                ...permissions,
            }),
        requests,
        fail: status => {
            failing = status;
        },
        refuse: (method, path, status, message = { message: `${status} refused` }) => {
            const refusal = { method, path, status, message };
            refusals.push(refusal);
            return () => void refusals.splice(refusals.indexOf(refusal), 1);
        },
        close: (path, number) => {
            pullRequest(repo(path), number).state = 'closed';
        },
        merge: (path, number) => {
            const merged = pullRequest(repo(path), number);
            merged.state = 'closed';
            merged.merged_at = new Date().toISOString();
        },
        fork: (path, owner, branch, base) => {
            const r = repo(path);
            const number = r.pullRequests.length + 1;
            const created: GitHubPullRequest = {
                number,
                title: `${owner}'s ${branch}`,
                body: '',
                state: 'open',
                merged_at: null,
                head: { ref: branch, label: `${owner}:${branch}`, repo: { full_name: `${owner}/${r.full_name.split('/')[1]}` } },
                base: { ref: base },
                html_url: `${origin}/${r.full_name}/pull/${number}`,
                created_at: new Date().toISOString(),
            };
            r.pullRequests.push(created);
            return created;
        },
        ruleset: (path, { branches, rules, bypass = 'never', name }) => {
            const id = nextRuleset++;
            repo(path).rulesets.push({ id, name: name ?? `ruleset ${id}`, branches, rules, bypass });
            return id;
        },
        protect: (path, branch, { enforceAdmins = true } = {}) => {
            repo(path).classic[branch] = { enforce_admins: enforceAdmins };
        },
        deniesProtectionWith: status => {
            protectionDenied = status;
            return () => {
                protectionDenied = 403;
            };
        },
        route: handler => void routes.push(handler),
        stop: () => server.stop(true),
    };
}
