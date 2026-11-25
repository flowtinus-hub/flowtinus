import type { GitAccess } from './git-remote';
import { gitlabAdapter } from './gitlab-adapter';
import { providerOf, type Provider } from './pull-request';

export type PullRequestState = 'open' | 'merged' | 'closed';

export type ProviderPullRequest = { number: number; url: string; source: string; target: string; title: string; state: PullRequestState };

/** squash: false turns it off, absent keeps the project's default */
export type NewPullRequest = {
    source: string;
    target: string;
    title: string;
    description: string;
    squash?: false;
    removeSourceBranch: boolean;
};

/** squash 'default': on unless the author turns it off; 'optional': off unless turned on */
export type MergeSettings = {
    squash: 'never' | 'optional' | 'default' | 'always';
    mergeMethod: 'merge' | 'semi-linear' | 'fast-forward';
};

export type AccessRule = 'nobody' | 'maintainers' | 'developers';

/** branch: a name or a wildcard pattern; a branch no rule matches takes pushes from developers */
export type BranchProtection = { branch: string; push: AccessRule; merge: AccessRule; forcePush: boolean };

export interface ProviderAdapter {
    readonly provider: Provider;
    openPullRequest(request: NewPullRequest): Promise<ProviderPullRequest>;
    findOpenPullRequest(source: string, target: string): Promise<ProviderPullRequest | null>;
    openPullRequestsInto(target: string): Promise<ProviderPullRequest[]>;
    /** in every state */
    pullRequestsInto(target: string, openedSince: Date): Promise<ProviderPullRequest[]>;
    pullRequest(number: number): Promise<ProviderPullRequest>;
    mergeSettings(): Promise<MergeSettings>;
    branchProtections(): Promise<BranchProtection[]>;
}

/** status null: the provider did not answer */
export class ProviderError extends Error {
    override name = 'ProviderError';
    constructor(
        message: string,
        readonly status: number | null,
    ) {
        super(message);
    }
}

export const API_NOTICE = 'The API is not reachable with this token: add the `api` scope to use the adapter.';

/** provider null: one the app does not know; adapter null: push and link, with a notice when the provider has an adapter */
export type AdapterStatus =
    | { provider: Provider | null; adapter: ProviderAdapter; notice: null }
    | { provider: Provider | null; adapter: null; notice: string | null };

export async function providerAdapter(access: GitAccess): Promise<AdapterStatus> {
    const provider = await providerOf(access.repository);
    if (provider !== 'gitlab') {
        return { provider, adapter: null, notice: null };
    }
    const reached = await gitlabAdapter(access);
    return 'adapter' in reached
        ? { provider, adapter: reached.adapter, notice: null }
        : { provider, adapter: null, notice: reached.notice };
}
