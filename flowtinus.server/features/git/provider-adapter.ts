import type { Provider } from './pull-request';

export type PullRequestState = 'open' | 'merged' | 'closed';

export type ProviderPullRequest = { number: number; url: string; source: string; target: string; state: PullRequestState };

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
export type BranchProtection = { branch: string; push: AccessRule };

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

export const PROVIDER_NAME: Record<Provider, string> = { gitlab: 'GitLab', github: 'GitHub' };

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

export function providerNotice(provider: Provider, error: unknown): string {
    if (!(error instanceof ProviderError)) {
        throw error;
    }
    if (error.status === 401 || error.status === 403) {
        return API_NOTICE;
    }
    if (error.status === null || error.status >= 500) {
        return `${PROVIDER_NAME[provider]}'s API did not answer: ${error.message}`;
    }
    return `${PROVIDER_NAME[provider]}'s API answered ${error.status}: ${error.message}`;
}

export async function unlessProviderFails<T>(answer: Promise<T>, fallback: T): Promise<T> {
    try {
        return await answer;
    } catch (e) {
        if (e instanceof ProviderError) {
            return fallback;
        }
        throw e;
    }
}
