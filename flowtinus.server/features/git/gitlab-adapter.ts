import type { GitAccess } from './git-remote';
import { API_NOTICE, ProviderError, providerNotice, type AccessRule, type BranchProtection, type MergeLimit, type MergeMethod, type MergeSettings, type NewPullRequest, type ProviderAdapter, type ProviderPullRequest } from './provider-adapter';

const TIMEOUT_MS = 10_000;

const PAGE = 100;

type MergeRequest = { iid: number; web_url: string; source_branch: string; target_branch: string; state: string };

type AccessLevels = { access_level: number | null }[];

type ProtectedBranch = { name: string; push_access_levels: AccessLevels };

const DEVELOPER = 30;

const FAST_FORWARD_ONLY: Record<string, MergeLimit> = { ff: 'fast-forward-only', rebase_merge: 'semi-linear-only' };

const OPENNESS: AccessRule[] = ['nobody', 'maintainers', 'developers'];

const pattern = (branch: string) =>
    new RegExp(
        `^${branch
            .split('*')
            .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*')}$`,
    );

// a branch several rules match takes the most permissive one, as GitLab does
function whoPushes(protections: ProtectedBranch[], branch: string): AccessRule {
    const matching = protections.filter(p => pattern(p.name).test(branch)).map(p => OPENNESS.indexOf(accessRuleOf(p.push_access_levels)));
    return matching.length ? OPENNESS[Math.max(...matching)]! : 'developers';
}

const toPullRequest = (m: MergeRequest): ProviderPullRequest => ({
    number: m.iid,
    url: m.web_url,
    source: m.source_branch,
    target: m.target_branch,
    state: m.state === 'merged' ? 'merged' : m.state === 'closed' ? 'closed' : 'open',
});

// a level of 0 is "no one"; an entry for a user or a group has none, and lets only them
function accessRuleOf(levels: AccessLevels): AccessRule {
    const lowest = Math.min(...levels.map(l => l.access_level).filter((l): l is number => !!l));
    return lowest <= DEVELOPER ? 'developers' : lowest < Infinity ? 'maintainers' : 'nobody';
}

function jsonOf(text: string): { message?: unknown; error?: unknown; error_description?: unknown } {
    try {
        return JSON.parse(text) ?? {};
    } catch {
        return {};
    }
}

async function errorOf(response: Response): Promise<string> {
    const text = await response.text().catch(() => '');
    const body = jsonOf(text);
    const message = body.message ?? body.error_description ?? body.error;
    if (message !== undefined) {
        return typeof message === 'string' ? message : JSON.stringify(message);
    }
    return text.trim().slice(0, 200) || `${response.status} ${response.statusText}`;
}

class GitLabClient implements ProviderAdapter {
    readonly provider = 'gitlab' as const;
    readonly canTurnSquashOff = true;
    private readonly api: string;
    private readonly project: string;

    constructor(private readonly access: GitAccess) {
        const url = new URL(access.repository);
        this.api = `${url.origin}/api/v4`;
        this.project = `/projects/${encodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, ''))}`;
    }

    private async call<T>(method: string, path: string, body?: unknown): Promise<{ value: T; next: string | null }> {
        let response: Response;
        try {
            response = await fetch(`${this.api}${path}`, {
                method,
                headers: { 'private-token': this.access.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: 'manual',
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (e) {
            throw new ProviderError((e as Error).message, null);
        }
        if (!response.ok) {
            throw new ProviderError(await errorOf(response), response.status);
        }
        return { value: (await response.json()) as T, next: response.headers.get('x-next-page') || null };
    }

    private async list<T>(path: string, query: Record<string, string> = {}): Promise<T[]> {
        const items: T[] = [];
        let page: string | null = '1';
        while (page) {
            const params = new URLSearchParams({ ...query, per_page: String(PAGE), page });
            const answer: { value: T[]; next: string | null } = await this.call<T[]>('GET', `${path}?${params}`);
            items.push(...answer.value);
            page = answer.next;
        }
        return items;
    }

    async scopes(): Promise<string[]> {
        return (await this.call<{ scopes?: string[] }>('GET', '/personal_access_tokens/self')).value.scopes ?? [];
    }

    async projectPath(): Promise<string> {
        return (await this.call<{ path_with_namespace: string }>('GET', this.project)).value.path_with_namespace;
    }

    async openPullRequest(request: NewPullRequest): Promise<ProviderPullRequest> {
        const created = await this.call<MergeRequest>('POST', `${this.project}/merge_requests`, {
            source_branch: request.source,
            target_branch: request.target,
            title: request.title,
            description: request.description,
            remove_source_branch: request.removeSourceBranch,
            ...(request.squash === false ? { squash: false } : {}),
        });
        return toPullRequest(created.value);
    }

    async findOpenPullRequest(source: string, target: string): Promise<ProviderPullRequest | null> {
        const [found] = await this.list<MergeRequest>(`${this.project}/merge_requests`, {
            state: 'opened',
            source_branch: source,
            target_branch: target,
        });
        return found ? toPullRequest(found) : null;
    }

    async openPullRequestsInto(target: string): Promise<ProviderPullRequest[]> {
        return (await this.list<MergeRequest>(`${this.project}/merge_requests`, { state: 'opened', target_branch: target })).map(
            toPullRequest,
        );
    }

    async pullRequestsInto(target: string, openedSince: Date): Promise<ProviderPullRequest[]> {
        return (
            await this.list<MergeRequest>(`${this.project}/merge_requests`, {
                target_branch: target,
                created_after: openedSince.toISOString(),
            })
        ).map(toPullRequest);
    }

    async pullRequest(number: number): Promise<ProviderPullRequest> {
        return toPullRequest((await this.call<MergeRequest>('GET', `${this.project}/merge_requests/${number}`)).value);
    }

    // the project's settings, the same into every branch
    async mergeSettings(): Promise<MergeSettings> {
        const { value } = await this.call<{ squash_option?: string; merge_method?: string }>('GET', this.project);
        const forced = value.squash_option === 'always';
        const fastForwardOnly = FAST_FORWARD_ONLY[value.merge_method ?? ''];
        const methods: MergeMethod[] = forced ? [] : [fastForwardOnly ? 'fast-forward' : 'merge-commit'];
        if (value.squash_option !== 'never') {
            methods.push('squash');
        }
        const limits: MergeLimit[] = [...(forced ? (['squash-forced'] as const) : []), ...(fastForwardOnly ? [fastForwardOnly] : [])];
        return { methods, limits };
    }

    async branchProtections(branches: string[]): Promise<BranchProtection[]> {
        const protections = await this.list<ProtectedBranch>(`${this.project}/protected_branches`);
        return branches.map(branch => ({ branch, push: whoPushes(protections, branch) }));
    }
}

export async function gitlabAdapter(access: GitAccess): Promise<{ adapter: ProviderAdapter } | { notice: string }> {
    const client = new GitLabClient(access);
    try {
        if (!(await client.scopes()).includes('api')) {
            return { notice: API_NOTICE.gitlab };
        }
        await client.projectPath();
        return { adapter: client };
    } catch (e) {
        return { notice: providerNotice('gitlab', e) };
    }
}
