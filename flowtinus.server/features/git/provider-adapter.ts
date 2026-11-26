import type { Provider } from './pull-request';

export type PullRequestState = 'open' | 'merged' | 'closed';

export type ProviderPullRequest = { number: number; url: string; source: string; target: string; state: PullRequestState };

/** squash: false turns it off, absent keeps the project's default; neither it nor removeSourceBranch reaches GitHub */
export type NewPullRequest = {
    source: string;
    target: string;
    title: string;
    description: string;
    squash?: false;
    removeSourceBranch: boolean;
};

export type MergeMethod = 'merge-commit' | 'fast-forward' | 'squash' | 'rebase';

export type MergeLimit =
    | 'squash-forced'
    | 'fast-forward-only'
    | 'semi-linear-only'
    | 'merge-commits-off'
    | 'linear-history-required'
    | 'merge-commit-not-allowed-by-rule';

export type MergeSettings = { methods: MergeMethod[]; limits: MergeLimit[] };

export type AccessRule = 'nobody' | 'maintainers' | 'developers';

export const OPENNESS: AccessRule[] = ['nobody', 'maintainers', 'developers'];

/** unknown: protection the token may not read (GitHub's classic one), which gives no warning */
export type BranchProtection = { branch: string; push: AccessRule | 'unknown' };

export interface ProviderAdapter {
    readonly provider: Provider;
    readonly canTurnSquashOff: boolean;
    openPullRequest(request: NewPullRequest): Promise<ProviderPullRequest>;
    findOpenPullRequest(source: string, target: string): Promise<ProviderPullRequest | null>;
    openPullRequestsInto(target: string): Promise<ProviderPullRequest[]>;
    /** in every state */
    pullRequestsInto(target: string, openedSince: Date): Promise<ProviderPullRequest[]>;
    pullRequest(number: number): Promise<ProviderPullRequest>;
    /** null: the provider does not tell this token (GitHub, to a token that cannot write) */
    mergeSettings(target: string): Promise<MergeSettings | null>;
    /** absent on GitLab, which removes the source branch per merge request; null: the provider does not tell this token */
    deletesMergedBranches?(): Promise<boolean | null>;
    branchProtections(branches: string[]): Promise<BranchProtection[]>;
}

export const PROVIDER_NAME: Record<Provider, string> = { gitlab: 'GitLab', github: 'GitHub' };

export const PULL_REQUEST_NAME: Record<Provider, string> = { gitlab: 'merge request', github: 'pull request' };

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
