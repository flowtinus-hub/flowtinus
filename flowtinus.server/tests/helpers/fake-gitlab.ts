export type GitLabMergeRequest = {
    iid: number;
    source_branch: string;
    target_branch: string;
    title: string;
    description: string;
    state: 'opened' | 'closed' | 'merged';
    squash: boolean;
    force_remove_source_branch: boolean;
    web_url: string;
    created_at: string;
};

export type GitLabAccessLevel = 0 | 30 | 40;

export type GitLabProtectedBranch = {
    name: string;
    push_access_levels: { access_level: GitLabAccessLevel }[];
    merge_access_levels: { access_level: GitLabAccessLevel }[];
    allow_force_push: boolean;
};

export type GitLabProject = {
    path: string;
    squash_option: 'never' | 'always' | 'default_on' | 'default_off';
    merge_method: 'merge' | 'rebase_merge' | 'ff';
    protectedBranches: GitLabProtectedBranch[];
    mergeRequests: GitLabMergeRequest[];
};

export type RecordedRequest = { method: string; path: string; query: Record<string, string>; body: any; token: string | null };

type Answer = Response | Promise<Response>;

export type FakeRoute = (request: { method: string; path: string; query: URLSearchParams; body: any; token: string }) => Answer | null;

export type FakeGitLab = {
    origin: string;
    repository(path: string): string;
    project(path: string): GitLabProject;
    token(value: string, scopes: string[]): void;
    requests: RecordedRequest[];
    fail(status: number | null): void;
    refuse(method: string, path: RegExp, status: number, message?: unknown): () => void;
    close(path: string, iid: number): void;
    merge(path: string, iid: number): void;
    protect(path: string, branch: string, levels?: { push?: GitLabAccessLevel; merge?: GitLabAccessLevel }): void;
    route(handler: FakeRoute): void;
    stop(): Promise<void>;
};

const META = { 'X-Gitlab-Meta': '{"cors":"","version":"1"}' };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: META });

const INSUFFICIENT_SCOPE = {
    error: 'insufficient_scope',
    error_description: 'The request requires higher privileges than provided by the access token.',
    scope: 'api read_api',
};

export function fakeGitLab(): FakeGitLab {
    const projects = new Map<string, GitLabProject>();
    const tokens = new Map<string, string[]>();
    const requests: RecordedRequest[] = [];
    const routes: FakeRoute[] = [];
    const refusals: { method: string; path: RegExp; status: number; message: unknown }[] = [];
    let failing: number | null = null;
    let origin = '';

    const project = (path: string): GitLabProject => {
        const key = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
        let found = projects.get(key);
        if (!found) {
            found = { path: key, squash_option: 'default_off', merge_method: 'merge', protectedBranches: [], mergeRequests: [] };
            projects.set(key, found);
        }
        return found;
    };

    const projectView = (p: GitLabProject) => ({
        id: [...projects.keys()].indexOf(p.path) + 1,
        path_with_namespace: p.path,
        web_url: `${origin}/${p.path}`,
        squash_option: p.squash_option,
        merge_method: p.merge_method,
    });

    const mergeRequest = (p: GitLabProject, iid: number) => {
        const found = p.mergeRequests.find(m => m.iid === iid);
        if (!found) {
            throw new Error(`No merge request !${iid} in ${p.path}`);
        }
        return found;
    };

    function builtIn(method: string, path: string, query: URLSearchParams, body: any, scopes: string[]): Answer {
        const reads = scopes.includes('api') || scopes.includes('read_api');
        if (!reads || (method !== 'GET' && !scopes.includes('api'))) {
            return json(INSUFFICIENT_SCOPE, 403);
        }
        if (method === 'GET' && path === '/personal_access_tokens/self') {
            return json({ id: 1, name: 'flowtinus', active: true, revoked: false, scopes });
        }

        const match = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
        const p = match ? projects.get(decodeURIComponent(match[1]!)) : undefined;
        if (!match || !p) {
            return json({ message: '404 Project Not Found' }, 404);
        }
        const rest = match[2] ?? '';

        if (method === 'GET' && rest === '') {
            return json(projectView(p));
        }
        if (method === 'GET' && rest === '/protected_branches') {
            return json(p.protectedBranches);
        }
        if (method === 'GET' && rest === '/merge_requests') {
            const state = query.get('state');
            return json(
                p.mergeRequests.filter(
                    m =>
                        (!state || state === 'all' || m.state === state) &&
                        (!query.get('source_branch') || m.source_branch === query.get('source_branch')) &&
                        (!query.get('target_branch') || m.target_branch === query.get('target_branch')) &&
                        (!query.get('created_after') || m.created_at > new Date(query.get('created_after')!).toISOString()),
                ),
            );
        }
        const one = /^\/merge_requests\/(\d+)$/.exec(rest);
        if (method === 'GET' && one) {
            const found = p.mergeRequests.find(m => m.iid === Number(one[1]));
            return found ? json(found) : json({ message: '404 Not found' }, 404);
        }
        if (method === 'POST' && rest === '/merge_requests') {
            const open = p.mergeRequests.find(
                m => m.state === 'opened' && m.source_branch === body?.source_branch && m.target_branch === body?.target_branch,
            );
            if (open) {
                return json({ message: [`Another open merge request already exists for this source branch: !${open.iid}`] }, 409);
            }
            if (!body?.source_branch || !body?.target_branch || !body?.title) {
                return json({ error: 'source_branch, target_branch, title are missing' }, 400);
            }
            const squash =
                p.squash_option === 'always'
                    ? true
                    : p.squash_option === 'never'
                      ? false
                      : (body.squash ?? p.squash_option === 'default_on');
            const iid = p.mergeRequests.length + 1;
            const created: GitLabMergeRequest = {
                iid,
                source_branch: body.source_branch,
                target_branch: body.target_branch,
                title: body.title,
                description: body.description ?? '',
                state: 'opened',
                squash,
                force_remove_source_branch: !!body.remove_source_branch,
                web_url: `${origin}/${p.path}/-/merge_requests/${iid}`,
                created_at: new Date().toISOString(),
            };
            p.mergeRequests.push(created);
            return json(created, 201);
        }
        return json({ error: '404 Not Found' }, 404);
    }

    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async request => {
            const url = new URL(request.url);
            if (!url.pathname.startsWith('/api/v4/')) {
                return new Response('not found', { status: 404 });
            }
            const path = url.pathname.slice('/api/v4'.length);
            const token = request.headers.get('private-token') ?? request.headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
            const text = await request.text();
            const body = text ? JSON.parse(text) : undefined;
            requests.push({
                method: request.method,
                path: decodeURIComponent(path),
                query: Object.fromEntries(url.searchParams),
                body,
                token,
            });

            if (failing !== null) {
                return new Response('GitLab is not responding', { status: failing });
            }
            const refusal = refusals.find(r => r.method === request.method && r.path.test(decodeURIComponent(path)));
            if (refusal) {
                return json(refusal.message, refusal.status);
            }
            const scopes = token === null ? undefined : tokens.get(token);
            if (path === '/version') {
                return scopes ? json({ version: '19.5.5', revision: 'fake' }) : json({ message: '401 Unauthorized' }, 401);
            }
            if (!scopes) {
                return json({ message: '401 Unauthorized' }, 401);
            }
            for (const route of routes) {
                const answer = route({ method: request.method, path, query: url.searchParams, body, token: token! });
                if (answer) {
                    return answer;
                }
            }
            return builtIn(request.method, path, url.searchParams, body, scopes);
        },
    });
    origin = `http://127.0.0.1:${server.port}`;

    return {
        origin,
        repository: path => `${origin}/${project(path).path}.git`,
        project,
        token: (value, scopes) => void tokens.set(value, scopes),
        requests,
        fail: status => {
            failing = status;
        },
        refuse: (method, path, status, message = { message: `${status} refused` }) => {
            const refusal = { method, path, status, message };
            refusals.push(refusal);
            return () => void refusals.splice(refusals.indexOf(refusal), 1);
        },
        close: (path, iid) => {
            mergeRequest(project(path), iid).state = 'closed';
        },
        merge: (path, iid) => {
            mergeRequest(project(path), iid).state = 'merged';
        },
        protect: (path, branch, levels = {}) => {
            const p = project(path);
            p.protectedBranches = p.protectedBranches.filter(b => b.name !== branch);
            p.protectedBranches.push({
                name: branch,
                push_access_levels: [{ access_level: levels.push ?? 40 }],
                merge_access_levels: [{ access_level: levels.merge ?? 40 }],
                allow_force_push: false,
            });
        },
        route: handler => void routes.push(handler),
        stop: () => server.stop(true),
    };
}
