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

/** 'fast-forward' keeps the commit only when the target is an ancestor of it; 'rebase' writes new commits */
export type MergeMethod = 'merge-commit' | 'fast-forward' | 'squash' | 'rebase';

/** the provider's settings that leave a merge commit out */
export type MergeLimit = 'squash-forced' | 'fast-forward-only' | 'semi-linear-only';

/** methods: those a pull request into the target may use */
export type MergeSettings = { methods: MergeMethod[]; limits: MergeLimit[] };

export type AccessRule = 'nobody' | 'maintainers' | 'developers';

export type BranchProtection = { branch: string; push: AccessRule };

export interface ProviderAdapter {
    readonly provider: Provider;
    /** whether a new pull request can be kept from being squashed */
    readonly canTurnSquashOff: boolean;
    openPullRequest(request: NewPullRequest): Promise<ProviderPullRequest>;
    findOpenPullRequest(source: string, target: string): Promise<ProviderPullRequest | null>;
    openPullRequestsInto(target: string): Promise<ProviderPullRequest[]>;
    /** in every state */
    pullRequestsInto(target: string, openedSince: Date): Promise<ProviderPullRequest[]>;
    pullRequest(number: number): Promise<ProviderPullRequest>;
    mergeSettings(target: string): Promise<MergeSettings>;
    /** one per branch asked for, in that order */
    branchProtections(branches: string[]): Promise<BranchProtection[]>;
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

export const API_NOTICE: Record<Provider, string> = {
    gitlab: 'The API is not reachable with this token: add the `api` scope to use the adapter.',
    github: 'The API is not reachable with this token: a classic token needs the `repo` scope (`public_repo` for a public repository); a fine-grained one needs Contents and Pull requests, read and write, on this repository.',
};

export function providerNotice(provider: Provider, error: unknown): string {
    if (!(error instanceof ProviderError)) {
        throw error;
    }
    if (error.status === 401 || error.status === 403) {
        return API_NOTICE[provider];
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
