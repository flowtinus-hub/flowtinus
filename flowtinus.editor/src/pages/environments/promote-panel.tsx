import { useState, type ReactNode } from 'react';
import type { TreeIssue } from '@flowtinus/core';
import { ArrowRight, CircleCheck, CircleX, ExternalLink, GitBranch, GitMerge, GitPullRequestArrow, LoaderCircle, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { shortSha } from '@/data/deployments/deployment';
import { useResource } from '@/data/use-resource';
import { getBackportPreflight, getCommitGraph, getPreflight, openBackport, openPromotion, openRepair, promotionSha, PROVIDERS, setCurrentBranch, type BackportPreflight, type CommitGraph as Graph, type EnvironmentEdge, type FlowChange, type GraphCommit, type OpenedBackport, type OpenedPromotion, type Preflight, type Promotion, type Provider } from '@/data/git/git-api';
import { landAfterSwitch } from '@/layout/branch-landing';
import type { ApiResult } from '@/lib/api';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { CommitGraph } from './commit-graph';

type PromoteEdge = {
    handle: string;
    edge: EnvironmentEdge;
    sourceBranch: string;
    targetBranch: string;
    canPromote: boolean;
    onOpened: () => void;
};

const CHANGE: Record<FlowChange, string> = {
    added: 'added',
    removed: 'removed',
    renamed: 'renamed',
    changed: 'changed',
    deployed: 'turned deployed',
    undeployed: 'turned undeployed',
};

const FILE_STATUS = { added: 'A', modified: 'M', deleted: 'D' } as const;

function useOpening<T>(request: () => Promise<ApiResult<T>>, onOpened?: () => void) {
    const [opening, setOpening] = useState(false);
    const [opened, setOpened] = useState<{ value?: T; error?: string } | null>(null);
    const open = async () => {
        setOpening(true);
        const answer = await request();
        setOpening(false);
        setOpened(answer.ok ? { value: answer.value } : { error: answer.error.message });
        if (answer.ok) {
            onOpened?.();
        }
    };
    return { opening, opened, open };
}

function PullRequestLink({
    url,
    provider,
    branch,
    targetBranch,
    number,
    notice,
    size,
}: {
    url: string | null;
    provider: Provider | null;
    branch: string;
    targetBranch: string;
    number?: number | null;
    notice?: string;
    size?: 'sm';
}) {
    const where = provider ? PROVIDERS[provider] : 'the provider';
    return (
        <>
            {url ? (
                <Button size={size} asChild>
                    <a href={url} target="_blank" rel="noreferrer">
                        <ExternalLink />
                        {number ? `Open merge request !${number} on ${where}` : `Open the pull request on ${where}`}
                    </a>
                </Button>
            ) : (
                <span className="text-muted-foreground">
                    Open a pull request from <span className="font-mono">{branch}</span> into{' '}
                    <span className="font-mono">{targetBranch}</span> on your git provider.
                </span>
            )}
            {notice && <span className="text-xs text-amber-700 dark:text-amber-400">{notice}</span>}
        </>
    );
}

export function PromotePanel({
    handle,
    edges,
    branchOf,
    canPromote,
    onOpened,
}: {
    handle: string;
    edges: EnvironmentEdge[];
    branchOf: (env: string) => string;
    canPromote: boolean;
    onOpened: () => void;
}) {
    const [active, setActive] = useState(edges[0]?.target ?? '');
    const edge = edges.find(e => e.target === active) ?? edges[0];
    if (!edge) {
        return null;
    }
    const brokenBackports = edge.backports.filter(p => p.state === 'broken');
    const promote: PromoteEdge = {
        handle,
        edge,
        sourceBranch: branchOf(edge.source),
        targetBranch: branchOf(edge.target),
        canPromote,
        onOpened,
    };
    return (
        <section className="grid gap-3">
            <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold">Promote from {edge.source}</h2>
                {edges.length > 1 && (
                    <div className="flex flex-wrap rounded-lg border p-0.5" role="tablist">
                        {edges.map(e => (
                            <button
                                key={e.target}
                                type="button"
                                role="tab"
                                aria-selected={e.target === edge.target}
                                className={cn(
                                    'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs',
                                    e.target === edge.target ? 'bg-muted font-semibold' : 'text-muted-foreground hover:text-foreground',
                                )}
                                onClick={() => setActive(e.target)}
                            >
                                {e.source} <ArrowRight className="size-3" /> {e.target}
                                {e.broken.length > 0 && <CircleX className="size-3 text-destructive" />}
                                {e.ahead && <TriangleAlert className="size-3 text-amber-500" />}
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {edge.broken.length > 0 && <BrokenLineage key={`broken:${edge.target}`} promote={promote} />}
            {brokenBackports.length > 0 && (
                <BrokenBackports key={`broken-backports:${edge.target}`} promote={promote} broken={brokenBackports} />
            )}
            {edge.ahead && <Backport key={`backport:${edge.target}`} promote={promote} />}
            {edge.targetExists ? (
                <EdgePanel key={edge.target} promote={promote} />
            ) : (
                <p className="rounded-lg border p-4 text-sm text-muted-foreground">
                    The branch <span className="font-mono">{promote.targetBranch}</span> of {edge.target} does not exist: turning git on in{' '}
                    {edge.target} creates it. Nothing to promote until then.
                </p>
            )}
        </section>
    );
}

/** the edge is blocked until a repair of each broken promotion is merged: a merge of its sha that keeps the target's tree */
function BrokenLineage({ promote }: { promote: PromoteEdge }) {
    const { edge, targetBranch } = promote;
    return (
        <div className="grid gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p className="flex gap-2">
                <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
                <span>
                    The lineage into <span className="font-mono">{targetBranch}</span> is broken: a promotion reached it by a squash or a
                    rebase, so its commit is not in <span className="font-mono">{targetBranch}</span>. Promoting along this edge is blocked
                    until a repair is merged. The repair changes no file and deploys nothing.
                </span>
            </p>
            <ul className="grid gap-2">
                {edge.broken.map(promotion => (
                    <RepairRow key={promotion.id} promote={promote} promotion={promotion} into={targetBranch} />
                ))}
            </ul>
        </div>
    );
}

function BrokenBackports({ promote, broken }: { promote: PromoteEdge; broken: Promotion[] }) {
    const { sourceBranch } = promote;
    return (
        <div className="grid gap-3 rounded-lg border p-4 text-sm">
            <p className="flex gap-2">
                <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
                <span>
                    A backport reached <span className="font-mono">{sourceBranch}</span> by a squash or a rebase: it has the changes but not
                    the commit. This blocks nothing; a repair mends the history. It changes no file and deploys nothing.
                </span>
            </p>
            <ul className="grid gap-2">
                {broken.map(promotion => (
                    <RepairRow key={promotion.id} promote={promote} promotion={promotion} into={sourceBranch} />
                ))}
            </ul>
        </div>
    );
}

function RepairRow({ promote, promotion, into }: { promote: PromoteEdge; promotion: Promotion; into: string }) {
    const { handle, canPromote: canRepair } = promote;
    const { opening, opened, open } = useOpening(() => openRepair(handle, promotion.id));
    const repair = opened?.value;

    return (
        <li className="grid gap-2">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                    <span className="font-mono">{promotionSha(promotion.sha)}</span>, from{' '}
                    <span className="font-mono">{promotion.branch}</span>
                </span>
                {canRepair && !repair && (
                    <Button size="sm" variant="outline" disabled={opening} onClick={() => void open()}>
                        {opening ? <LoaderCircle className="animate-spin" /> : <GitPullRequestArrow />}
                        Open repair
                    </Button>
                )}
            </span>
            {opened?.error && <span className="text-destructive">{opened.error}</span>}
            {repair && (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>
                        {repair.reused ? 'Already pushed: ' : 'Pushed '}
                        <span className="font-mono">{repair.branch}</span>.
                    </span>
                    <PullRequestLink
                        url={repair.url}
                        provider={repair.provider}
                        branch={repair.branch}
                        targetBranch={into}
                        number={repair.mergeRequest?.number}
                        notice={repair.notice}
                        size="sm"
                    />
                </span>
            )}
            {repair?.warnings.map(warning => (
                <span key={warning.kind} className="flex gap-2">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    <span>{emphasized(warning.message)}</span>
                </span>
            ))}
            {repair && (
                <span className="text-xs text-muted-foreground">
                    Merge it with a merge commit: a squash or a rebase would not mend the history.
                </span>
            )}
        </li>
    );
}

function Backport({ promote }: { promote: PromoteEdge }) {
    const { handle, edge, sourceBranch, targetBranch, canPromote: canBackport, onOpened } = promote;
    const checked = useResource(`backport:${handle}:${edge.target}`, () => getBackportPreflight(handle, edge.target));
    const { opening, opened, open } = useOpening(() => openBackport(handle, edge.target), onOpened);
    const preflight: BackportPreflight | null = checked.state.status === 'ready' ? checked.state.value : null;
    const same = preflight?.open.find(p => p.sha === preflight.sha);
    const others = preflight?.open.filter(p => p.sha !== preflight.sha) ?? [];
    const result = opened?.value;

    return (
        <div className="grid gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
            <p className="flex gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                <span>
                    {edge.target} is ahead of {edge.source}: <span className="font-mono">{targetBranch}</span> has changes{' '}
                    <span className="font-mono">{sourceBranch}</span> lacks. Promoting into {edge.target} is blocked until a backport brings
                    them into <span className="font-mono">{sourceBranch}</span>, as a merge of{' '}
                    <span className="font-mono">{targetBranch}</span>
                    's tip.
                </span>
            </p>
            {checked.state.status === 'error' && <p className="text-destructive">{checked.state.error.message}</p>}
            {checked.state.status === 'loading' && (
                <p className="flex items-center gap-2 text-muted-foreground">
                    <LoaderCircle className="size-4 animate-spin" /> Checking the backport...
                </p>
            )}
            {preflight && (
                <Checks blocks={preflight.blocks} warnings={preflight.warnings} clear="Nothing blocks the backport.">
                    {preflight.conflicts.length > 0 && (
                        <li className="flex gap-2">
                            <GitMerge className="mt-0.5 size-4 shrink-0 text-amber-500" />
                            <span className="grid gap-1">
                                {plural(preflight.conflicts.length, 'file')} conflict: the merge is left pending on its branch, to resolve
                                on the conflict screen before the pull request.
                                {preflight.conflicts.map(path => (
                                    <span key={path} className="truncate font-mono text-xs text-muted-foreground" title={path}>
                                        {path}
                                    </span>
                                ))}
                            </span>
                        </li>
                    )}
                </Checks>
            )}
            {others.length > 0 && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                    {others.length === 1 ? 'A backport' : 'Backports'} of{' '}
                    {others.map(p => (
                        <span key={p.id} className="font-mono">
                            {shortSha(p.sha)}{' '}
                        </span>
                    ))}
                    {others.length === 1 ? 'is' : 'are'} open on this edge. An older one counts as merged once a newer one is.
                </p>
            )}
            {canBackport && preflight && !result && (
                <div>
                    <Button disabled={preflight.blocks.length > 0 || opening} onClick={() => void open()}>
                        {opening ? <LoaderCircle className="animate-spin" /> : <GitPullRequestArrow />}
                        {same ? 'Open the backport again' : 'Open backport'}
                    </Button>
                </div>
            )}
            {opened?.error && <p className="text-destructive">{opened.error}</p>}
            {result && <OpenedBackportView handle={handle} opened={result} sourceBranch={sourceBranch} />}
            {preflight?.sha && preflight.branch && (
                <p className="text-xs text-muted-foreground">
                    From <span className="font-mono">{preflight.branch}</span>: <span className="font-mono">{sourceBranch}</span> with{' '}
                    <span className="font-mono">{targetBranch}</span> at <span className="font-mono">{promotionSha(preflight.sha)}</span>{' '}
                    merged in. Merge it without a squash or a rebase.
                </p>
            )}
        </div>
    );
}

function OpenedBackportView({ handle, opened, sourceBranch }: { handle: string; opened: OpenedBackport; sourceBranch: string }) {
    const { promotion, reused, conflicts, provider, notice } = opened;
    const [error, setError] = useState('');
    const goToBranch = async () => {
        const result = await setCurrentBranch(handle, promotion.branch);
        if (!result.ok) {
            setError(result.error.message);
            return;
        }
        await landAfterSwitch(handle);
    };
    return (
        <div className="grid gap-2">
            <p>
                {reused ? 'This backport was already open: ' : 'Pushed '}
                <span className="font-mono">{promotion.branch}</span>
                {conflicts.length > 0
                    ? `, its merge pending on this server: ${plural(conflicts.length, 'file')} to resolve on that branch, then Commit the merge and open its pull request.`
                    : '.'}
            </p>
            {conflicts.length > 0 ? (
                <div>
                    <Button variant="outline" onClick={() => void goToBranch()}>
                        <GitBranch />
                        Go to {promotion.branch}
                    </Button>
                </div>
            ) : (
                <PullRequestLink
                    url={promotion.url}
                    provider={provider}
                    branch={promotion.branch}
                    targetBranch={sourceBranch}
                    number={promotion.number}
                    notice={notice}
                />
            )}
            {error && <p className="text-destructive">{error}</p>}
        </div>
    );
}

function EdgePanel({ promote }: { promote: PromoteEdge }) {
    const { handle, edge, sourceBranch, targetBranch } = promote;
    const first = useResource(`promote-graph:${handle}:${edge.target}`, () => getCommitGraph(handle, edge.target));
    const [more, setMore] = useState<{ commits: GraphCommit[]; next: number | null } | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [picked, setPicked] = useState<string | null>(null);

    if (first.state.status !== 'ready') {
        return first.state.status === 'error' ? (
            <p className="text-sm text-destructive">{first.state.error.message}</p>
        ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" /> Reading {sourceBranch}...
            </p>
        );
    }
    const graph: Graph = first.state.value;
    const commits = [...graph.commits.filter(c => !more || !c.inTarget), ...(more?.commits ?? [])];
    const next = more ? more.next : graph.next;
    const pending = commits.filter(c => !c.inTarget);
    const chosen = picked ?? pending.find(c => c.choosable)?.sha ?? null;

    const loadMore = async () => {
        if (next === null) {
            return;
        }
        setLoadingMore(true);
        const page = await getCommitGraph(handle, edge.target, next);
        setLoadingMore(false);
        if (page.ok) {
            setMore({ commits: [...(more?.commits ?? []), ...page.value.commits], next: page.value.next });
        }
    };

    return (
        <div className="grid overflow-hidden rounded-lg border lg:grid-cols-[minmax(0,1fr)_24rem]">
            <div className="min-w-0">
                {pending.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground">
                        <span className="font-mono">{targetBranch}</span> has every commit of{' '}
                        <span className="font-mono">{sourceBranch}</span>.
                    </p>
                ) : (
                    <p className="border-b px-4 py-3 text-xs text-muted-foreground">
                        Choose the commit to promote: it goes with everything below it on its lines; what stays behind is dimmed. A small
                        dot came in through a merge and goes with that merge.
                    </p>
                )}
                <div className="max-h-[34rem] overflow-y-auto">
                    <CommitGraph commits={commits} branch={sourceBranch} chosen={chosen} onChoose={setPicked} />
                    {next !== null && (
                        <div className="p-3">
                            <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                                {loadingMore && <LoaderCircle className="animate-spin" />} Load more
                            </Button>
                        </div>
                    )}
                </div>
            </div>
            <aside className="grid content-start gap-5 border-t p-4 lg:border-t-0 lg:border-l">
                {chosen ? (
                    <PreflightView key={chosen} promote={promote} sha={chosen} />
                ) : (
                    <p className="text-sm text-muted-foreground">Nothing to promote.</p>
                )}
            </aside>
        </div>
    );
}

function PreflightView({ promote, sha }: { promote: PromoteEdge; sha: string }) {
    const { handle, edge, sourceBranch, targetBranch, canPromote, onOpened } = promote;
    const checked = useResource(`preflight:${handle}:${edge.target}:${sha}`, () => getPreflight(handle, edge.target, sha));
    const { opening, opened, open } = useOpening(() => openPromotion(handle, edge.target, sha), onOpened);

    if (checked.state.status !== 'ready') {
        return checked.state.status === 'error' ? (
            <p className="text-sm text-destructive">{checked.state.error.message}</p>
        ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" /> Running the pre-flight...
            </p>
        );
    }
    const preflight: Preflight = checked.state.value;
    const others = preflight.open.filter(p => p.sha !== sha);
    const same = preflight.open.find(p => p.sha === sha);
    const result = opened?.value;

    return (
        <>
            <Block title={`To promote: ${plural(preflight.files.length, 'file')}`}>
                {preflight.files.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No file changes.</p>
                ) : (
                    <ul className="grid max-h-48 gap-0.5 overflow-y-auto font-mono text-xs">
                        {preflight.files.map(file => (
                            <li key={file.path} className="flex gap-2" title={file.path}>
                                <span className="w-3 shrink-0 text-muted-foreground">{FILE_STATUS[file.status]}</span>
                                <span className="truncate">{file.path}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </Block>
            <Block title="Pre-flight">
                <Checks
                    blocks={preflight.blocks.map(block =>
                        block.kind === 'ahead'
                            ? {
                                  ...block,
                                  message: `${edge.target} is ahead of ${edge.source}: the backport above brings it into ${sourceBranch} first.`,
                              }
                            : block,
                    )}
                    warnings={preflight.warnings}
                    clear="Nothing blocks the promotion."
                />
            </Block>
            <Block title={`Impact on ${edge.target}`}>
                {preflight.impact.flows.length === 0 && preflight.impact.scripts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No flow or script changes.</p>
                ) : (
                    <ul className="grid gap-1 text-sm">
                        {preflight.impact.flows.map(flow => (
                            <li key={flow.id} className="flex items-baseline justify-between gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
                                <span className="min-w-0 truncate" title={flow.from ? `${flow.from} → ${flow.name}` : flow.name}>
                                    {flow.name}
                                    {flow.from && <span className="text-xs text-muted-foreground"> (was {flow.from})</span>}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {flow.changes.map(c => CHANGE[c]).join(', ')}
                                </span>
                            </li>
                        ))}
                        {preflight.impact.scripts.map(script => (
                            <li
                                key={script.path}
                                className="flex items-baseline justify-between gap-2 rounded-md bg-muted/50 px-2.5 py-1.5"
                            >
                                <span className="min-w-0 truncate font-mono text-xs">{script.path}.ts</span>
                                <span className="shrink-0 text-xs text-muted-foreground">script {script.change}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </Block>
            <div className="grid gap-2">
                {others.length > 0 && (
                    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                        {others.length === 1 ? 'A promotion' : 'Promotions'} of{' '}
                        {others.map(p => (
                            <span key={p.id} className="font-mono">
                                {shortSha(p.sha)}{' '}
                            </span>
                        ))}
                        {others.length === 1 ? 'is' : 'are'} open on this edge. An older one counts as merged once a newer one is.
                    </p>
                )}
                {canPromote && !result && (
                    <Button disabled={preflight.blocks.length > 0 || opening} onClick={() => void open()}>
                        {opening ? <LoaderCircle className="animate-spin" /> : <GitPullRequestArrow />}
                        {same ? 'Open the promotion again' : 'Promote'}
                    </Button>
                )}
                {opened?.error && <p className="text-sm text-destructive">{opened.error}</p>}
                {result && <OpenedView opened={result} targetBranch={targetBranch} />}
                <p className="text-center text-xs text-muted-foreground">
                    Up to <span className="font-mono">{promotionSha(sha)}</span> of <span className="font-mono">{sourceBranch}</span>, from{' '}
                    <span className="font-mono">{preflight.branch}</span>. Merge it without a squash or a rebase.
                </p>
            </div>
        </>
    );
}

function OpenedView({ opened, targetBranch }: { opened: OpenedPromotion; targetBranch: string }) {
    const { promotion, reused, provider, notice } = opened;
    return (
        <div className="grid gap-2 text-sm">
            <p>
                {reused ? 'This promotion was already open: ' : 'Pushed '}
                <span className="font-mono">{promotion.branch}</span>
                {reused ? '.' : ` at ${promotionSha(promotion.sha)}.`}
            </p>
            <PullRequestLink
                url={promotion.url}
                provider={provider}
                branch={promotion.branch}
                targetBranch={targetBranch}
                number={promotion.number}
                notice={notice}
            />
        </div>
    );
}

type Check = { kind: string; message: string };

const emphasized = (text: string) => text.split(/\*\*(.+?)\*\*/).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part));

function Checks({
    blocks,
    warnings,
    clear,
    children,
}: {
    blocks: (Check & { issues?: TreeIssue[] })[];
    warnings: (Check & { items: string[] })[];
    clear: string;
    children?: ReactNode;
}) {
    return (
        <ul className="grid gap-2 text-sm">
            {blocks.map(block => (
                <li key={block.kind} className="flex gap-2">
                    <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
                    <span className="grid gap-1">
                        {block.message}
                        {block.issues?.map(issue => (
                            <span key={`${issue.path}:${issue.message}`} className="text-xs text-muted-foreground">
                                <span className="font-mono">{issue.path}</span>: {issue.message}
                            </span>
                        ))}
                    </span>
                </li>
            ))}
            {blocks.length === 0 && (
                <li className="flex gap-2">
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                    {clear}
                </li>
            )}
            {children}
            {warnings.map(warning => (
                <li key={warning.kind} className="flex gap-2">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    <span className="grid gap-1">
                        <span>{emphasized(warning.message)}</span>
                        {warning.items.map(item => (
                            <span key={item} className="truncate text-xs text-muted-foreground" title={item}>
                                {item}
                            </span>
                        ))}
                    </span>
                </li>
            ))}
        </ul>
    );
}

const Block = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="grid gap-2">
        <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{title}</h3>
        {children}
    </div>
);
