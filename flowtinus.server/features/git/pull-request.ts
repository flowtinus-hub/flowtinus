import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { workspaceHandle } from '#features/folders/project-tree';
import { onClone } from './branch-read';
import { branchKind, canEditBranch, currentBranch, editorOf, opensIntoEnvironment } from './current-branch';
import { gitBranch, readGitConfig } from './git-config';
import { fetchHeads, readHeads, recordHeads } from './git-heads';
import { pendingMerge, pendingMergeRefusal } from './pending-merge';
import { issueFields, readBranchWorkspace, validateImport } from './workspace-import';

export type Provider = 'gitlab' | 'github';

export type PullRequestView = {
    branch: string;
    target: string;
    pushed: boolean;
    commits: number;
    borrowed: { branch: string; commits: number }[];
    provider: Provider | null;
    url: string | null;
};

const KNOWN_HOSTS: Record<string, Provider> = { 'github.com': 'github', 'www.github.com': 'github', 'gitlab.com': 'gitlab' };

const PROBE_MS = 5_000;

const probed = new Map<string, Provider | null>();

async function probe(url: string, header: string): Promise<boolean | null> {
    try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_MS) });
        await response.body?.cancel();
        return response.headers.has(header);
    } catch {
        return null;
    }
}

// a self-hosted GitLab or GitHub Enterprise is told by what its API answers without a token; a probe that got no answer is not kept
export async function providerOf(repository: string): Promise<Provider | null> {
    let url: URL;
    try {
        url = new URL(repository);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }
    const known = KNOWN_HOSTS[url.hostname.toLowerCase()];
    if (known) {
        return known;
    }
    if (probed.has(url.origin)) {
        return probed.get(url.origin)!;
    }

    const gitlab = await probe(`${url.origin}/api/v4/version`, 'x-gitlab-meta');
    const github = gitlab ? false : await probe(`${url.origin}/api/v3/meta`, 'x-github-request-id');
    const provider = gitlab ? 'gitlab' : github ? 'github' : null;
    if (gitlab !== null && github !== null) {
        probed.set(url.origin, provider);
    }
    return provider;
}

const segments = (branch: string) => encodeURIComponent(branch).replaceAll('%2F', '/');

export function pullRequestLink(repository: string, provider: Provider, source: string, target: string): string {
    const url = new URL(repository);
    const project = `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
    if (provider === 'github') {
        return `${project}/compare/${segments(target)}...${segments(source)}?expand=1`;
    }
    const query = new URLSearchParams({ 'merge_request[source_branch]': source, 'merge_request[target_branch]': target });
    return `${project}/-/merge_requests/new?${query}`;
}

export class OpenPullRequestHandler implements UseCaseHandler<PullRequestView> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<PullRequestView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const [git, branch, config] = await Promise.all([
            gitBranch(ctx.db, ctx.workspaceId),
            currentBranch(ctx.db, ctx.workspaceId, ctx.userId),
            readGitConfig(ctx.db, ctx.workspaceId),
        ]);
        if (!git?.branch || !branch || !config) {
            return fail('conflict', 'Git is off in this workspace: there are no branches.');
        }
        const target = git.branch;
        const editor = await editorOf(ctx.db, ctx.workspaceId, ctx.userId);
        const { kind } = branchKind(branch, [...editor.environments, target]);
        if (git.mode === 'protected' && !opensIntoEnvironment(kind)) {
            return fail('conflict', `${target} is protected: its server opens no pull request from a work branch.`);
        }
        if (branch === target) {
            return fail('conflict', `A pull request goes from a work branch into ${target}: create or pick one first.`);
        }
        if (kind === 'environment' || kind === 'app') {
            return fail('conflict', `${branch} is not a work branch: no pull request from it here.`);
        }
        if (!canEditBranch(branch, target, editor)) {
            return fail('conflict', `${branch} is not yours: only its owner opens its pull request.`);
        }
        const waiting = await pendingMerge(ctx.db, ctx.workspaceId, branch);
        if (waiting) {
            return fail('conflict', pendingMergeRefusal(waiting));
        }
        const handle = await workspaceHandle(ctx);

        const checked = await onClone(ctx, 'Git could not be reached, no pull request was opened', async remote => {
            const here = (await readHeads(ctx.db, ctx.workspaceId))?.heads.find(h => h.name === branch)?.sha;
            const fetched = await fetchHeads(remote);
            const there = fetched.fetched.get(branch);
            // only forward: a remote that moved past or away from the tip here is followed by the poll, not overwritten
            const pushed = !!here && here !== there && (await remote.hasCommit(here)) && (!there || (await remote.isAncestor(there, here)));
            const proposed = pushed ? here : there;
            // a hotfix's or a backport's tip is checked even when it is on the remote already (pushed by hand, or by the app from a
            // merge): it goes straight into the environment's branch
            if (proposed && (pushed || opensIntoEnvironment(kind))) {
                const { errors } = await validateImport(
                    ctx.db,
                    ctx.workspaceId,
                    handle,
                    await readBranchWorkspace(remote, proposed, handle),
                );
                if (errors.length > 0) {
                    return fail('validation', `${branch} is not valid: no pull request was opened.`, issueFields(errors));
                }
            }
            if (pushed) {
                await remote.push(here, branch, there ?? null);
                fetched.fetched.set(branch, here);
            }
            const heads = await recordHeads(ctx, remote, config, fetched);
            const head = heads.heads.find(h => h.name === branch);
            const tip = head && !head.removed ? head.sha : undefined;
            const targetTip = heads.heads.find(h => h.name === target)?.sha;
            if (!tip) {
                return fail('conflict', `The branch ${branch} is not in the repository any more.`);
            }
            if (!targetTip) {
                return fail('conflict', `The branch ${target} is not in the repository.`);
            }
            const ahead = async (sha: string) => Number((await remote.run(['rev-list', '--count', `${targetTip}..${sha}`])).trim());
            const commits = await ahead(tip);
            if (commits === 0) {
                return fail(
                    'conflict',
                    `${target} already contains every commit of ${branch} (it is merged, or nothing was committed on it yet): there is nothing for a pull request.`,
                );
            }

            const borrowed: PullRequestView['borrowed'] = [];
            for (const head of heads.heads) {
                const other = branchKind(head.name, heads.environments).kind;
                if (head.name === branch || head.sha === tip || head.merged || (other !== 'user' && other !== 'shared')) {
                    continue;
                }
                if (await remote.isAncestor(head.sha, tip)) {
                    borrowed.push({ branch: head.name, commits: await ahead(head.sha) });
                }
            }

            return success({ pushed, commits, borrowed });
        });
        if (!checked.ok) {
            return checked;
        }
        const provider = await providerOf(config.repository);
        return success({
            branch,
            target,
            ...checked.value,
            provider,
            url: provider ? pullRequestLink(config.repository, provider, branch, target) : null,
        });
    }
}
