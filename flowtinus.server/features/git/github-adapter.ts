import type { GitAccess } from './git-remote';
import { callProvider, PAGE } from './provider-api';
import { API_NOTICE, ProviderError, providerNotice, type AccessRule, type BranchProtection, type MergeLimit, type MergeMethod, type MergeSettings, type NewPullRequest, type ProviderAdapter, type ProviderPullRequest } from './provider-adapter';

type PullRequest = {
    number: number;
    html_url: string;
    state: string;
    merged_at: string | null;
    created_at: string;
    head: { ref: string; repo: { full_name: string } | null };
    base: { ref: string };
};

type Repository = {
    allow_merge_commit?: boolean;
    allow_squash_merge?: boolean;
    allow_rebase_merge?: boolean;
    delete_branch_on_merge?: boolean;
};

type Rule = { type: string; ruleset_id: number; parameters?: { allowed_merge_methods?: string[] } };

const API_VERSION = '2022-11-28';

const GITHUB_COM = new Set(['github.com', 'www.github.com']);

const CLASSIC_SCOPES = ['repo', 'public_repo'];

const PUSH_RULES = new Set(['update', 'pull_request']);

const METHODS: Record<string, MergeMethod> = { merge: 'merge-commit', squash: 'squash', rebase: 'rebase' };

const OPENNESS: AccessRule[] = ['nobody', 'maintainers', 'developers'];

const leastOpen = (a: AccessRule, b: AccessRule) => OPENNESS[Math.min(OPENNESS.indexOf(a), OPENNESS.indexOf(b))]!;

const nextOf = (link: string | null) => /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1] ?? null;

const segment = (branch: string) => encodeURIComponent(branch);

class GitHubClient implements ProviderAdapter {
    readonly provider = 'github' as const;
    readonly canTurnSquashOff = false;
    private readonly api: string;
    private readonly owner: string;
    private readonly repository: string;

    constructor(private readonly access: GitAccess) {
        const url = new URL(access.repository);
        this.api = GITHUB_COM.has(url.hostname.toLowerCase()) ? 'https://api.github.com' : `${url.origin}/api/v3`;
        const fullName = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
        this.owner = fullName.split('/')[0]!;
        this.repository = `/repos/${fullName}`;
    }

    private async call<T>(method: string, pathOrUrl: string, body?: unknown): Promise<{ value: T; response: Response }> {
        const url = pathOrUrl.startsWith('/') ? `${this.api}${pathOrUrl}` : pathOrUrl;
        const response = await callProvider(
            url,
            method,
            { authorization: `Bearer ${this.access.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': API_VERSION },
            body,
        );
        return { value: (await response.json()) as T, response };
    }

    /** stops at the first page where until says so, keeping that page's items before it */
    private async list<T>(path: string, query: Record<string, string> = {}, until?: (item: T) => boolean): Promise<T[]> {
        const items: T[] = [];
        let next: string | null = `${path}?${new URLSearchParams({ ...query, per_page: String(PAGE) })}`;
        while (next) {
            const { value, response }: { value: T[]; response: Response } = await this.call<T[]>('GET', next);
            const stop: number = until ? value.findIndex(until) : -1;
            items.push(...(stop < 0 ? value : value.slice(0, stop)));
            next = stop < 0 ? nextOf(response.headers.get('link')) : null;
        }
        return items;
    }

    private pulls(query: Record<string, string>, until?: (p: PullRequest) => boolean): Promise<ProviderPullRequest[]> {
        return this.list<PullRequest>(`${this.repository}/pulls`, query, until).then(all =>
            all.filter(p => this.ours(p)).map(toPullRequest),
        );
    }

    // a fork's pull request may carry the same branch name as one of ours; a deleted fork leaves no repo
    private ours(p: PullRequest): boolean {
        return p.head.repo?.full_name.toLowerCase() === this.repository.slice('/repos/'.length).toLowerCase();
    }

    /** null: the token is not a classic one */
    async scopes(): Promise<string[] | null> {
        const { response } = await this.call<unknown>('GET', this.repository);
        const header = response.headers.get('x-oauth-scopes');
        return header === null ? null : header.split(',').map(s => s.trim());
    }

    async readsPullRequests(): Promise<void> {
        await this.call<unknown>('GET', `${this.repository}/pulls?per_page=1`);
    }

    async openPullRequest(request: NewPullRequest): Promise<ProviderPullRequest> {
        const created = await this.call<PullRequest>('POST', `${this.repository}/pulls`, {
            head: request.source,
            base: request.target,
            title: request.title,
            body: request.description,
        });
        return toPullRequest(created.value);
    }

    async findOpenPullRequest(source: string, target: string): Promise<ProviderPullRequest | null> {
        const [found] = await this.pulls({ state: 'open', head: `${this.owner}:${source}`, base: target });
        return found ?? null;
    }

    openPullRequestsInto(target: string): Promise<ProviderPullRequest[]> {
        return this.pulls({ state: 'open', base: target });
    }

    pullRequestsInto(target: string, openedSince: Date): Promise<ProviderPullRequest[]> {
        const since = openedSince.toISOString();
        return this.pulls({ state: 'all', base: target, sort: 'created', direction: 'desc' }, p => p.created_at < since);
    }

    async pullRequest(number: number): Promise<ProviderPullRequest> {
        return toPullRequest((await this.call<PullRequest>('GET', `${this.repository}/pulls/${number}`)).value);
    }

    private rules(branch: string): Promise<Rule[]> {
        return this.list<Rule>(`${this.repository}/rules/branches/${segment(branch)}`);
    }

    async mergeSettings(target: string): Promise<MergeSettings | null> {
        const { value } = await this.call<Repository>('GET', this.repository);
        if (value.allow_merge_commit === undefined) {
            return null;
        }
        let methods: MergeMethod[] = [
            ...(value.allow_merge_commit ? (['merge-commit'] as const) : []),
            ...(value.allow_squash_merge ? (['squash'] as const) : []),
            ...(value.allow_rebase_merge ? (['rebase'] as const) : []),
        ];
        const limits: MergeLimit[] = value.allow_merge_commit ? [] : ['merge-commits-off'];
        for (const rule of await this.rules(target)) {
            if (rule.type === 'required_linear_history') {
                methods = methods.filter(m => m !== 'merge-commit');
                limits.push('linear-history-required');
            }
            const allowed = rule.type === 'pull_request' ? rule.parameters?.allowed_merge_methods : undefined;
            if (allowed) {
                const kept = new Set(allowed.map(m => METHODS[m]));
                methods = methods.filter(m => kept.has(m));
                if (!kept.has('merge-commit')) {
                    limits.push('merge-commit-not-allowed-by-rule');
                }
            }
        }
        return { methods, limits: [...new Set(limits)] };
    }

    async deletesMergedBranches(): Promise<boolean | null> {
        return (await this.call<Repository>('GET', this.repository)).value.delete_branch_on_merge ?? null;
    }

    async branchProtections(branches: string[]): Promise<BranchProtection[]> {
        const bypasses = new Map<number, Promise<boolean>>();
        const bypass = (id: number) => {
            if (!bypasses.has(id)) {
                const read = this.call<{ current_user_can_bypass?: string }>('GET', `${this.repository}/rulesets/${id}`);
                bypasses.set(
                    id,
                    read.then(r => r.value.current_user_can_bypass === 'always'),
                );
            }
            return bypasses.get(id)!;
        };
        const protections: BranchProtection[] = [];
        for (const branch of branches) {
            protections.push({ branch, push: await this.whoPushes(branch, bypass) });
        }
        return protections;
    }

    private async whoPushes(branch: string, bypass: (ruleset: number) => Promise<boolean>): Promise<AccessRule | 'unknown'> {
        const rulesets = [...new Set((await this.rules(branch)).filter(r => PUSH_RULES.has(r.type)).map(r => r.ruleset_id))];
        const bypassed = await Promise.all(rulesets.map(bypass));
        const byRules: AccessRule = rulesets.length === 0 ? 'developers' : bypassed.every(Boolean) ? 'maintainers' : 'nobody';
        if (byRules === 'nobody') {
            return byRules;
        }
        const classic = await this.classicProtection(branch);
        return classic === 'unknown' ? classic : leastOpen(byRules, classic);
    }

    // readable by an admin only; to anyone else only whether the branch is protected at all, by it or by a ruleset
    private async classicProtection(branch: string): Promise<AccessRule | 'unknown'> {
        try {
            const { value } = await this.call<{ enforce_admins?: { enabled: boolean } }>(
                'GET',
                `${this.repository}/branches/${segment(branch)}/protection`,
            );
            return value.enforce_admins?.enabled ? 'nobody' : 'maintainers';
        } catch (e) {
            if (!(e instanceof ProviderError) || (e.status !== 404 && e.status !== 403)) {
                throw e;
            }
            if (e.status === 404) {
                return 'developers';
            }
        }
        const { value } = await this.call<{ protected?: boolean }>('GET', `${this.repository}/branches/${segment(branch)}`);
        return value.protected ? 'unknown' : 'developers';
    }
}

const toPullRequest = (p: PullRequest): ProviderPullRequest => ({
    number: p.number,
    url: p.html_url,
    source: p.head.ref,
    target: p.base.ref,
    state: p.state === 'open' ? 'open' : p.merged_at ? 'merged' : 'closed',
});

export async function githubAdapter(access: GitAccess): Promise<{ adapter: ProviderAdapter } | { notice: string }> {
    const client = new GitHubClient(access);
    try {
        const scopes = await client.scopes();
        if (scopes && !scopes.some(s => CLASSIC_SCOPES.includes(s))) {
            return { notice: API_NOTICE.github };
        }
        await client.readsPullRequests();
        return { adapter: client };
    } catch (e) {
        return { notice: providerNotice('github', e) };
    }
}
