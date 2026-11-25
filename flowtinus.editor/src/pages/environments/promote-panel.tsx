import { useState, type ReactNode } from 'react';
import { ArrowRight, CircleCheck, CircleX, ExternalLink, GitPullRequestArrow, LoaderCircle, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useResource } from '@/data/use-resource';
import { getCommitGraph, getPreflight, openPromotion, type CommitGraph as Graph, type EnvironmentEdge, type FlowChange, type GraphCommit, type OpenedPromotion, type Preflight } from '@/data/git/git-api';
import { cn } from '@/lib/utils';
import { CommitGraph } from './commit-graph';

const PROVIDERS = { gitlab: 'GitLab', github: 'GitHub' };

const CHANGE: Record<FlowChange, string> = {
    added: 'added',
    removed: 'removed',
    renamed: 'renamed',
    changed: 'changed',
    deployed: 'turned deployed',
    undeployed: 'turned undeployed',
};

const FILE_STATUS = { added: 'A', modified: 'M', deleted: 'D' } as const;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** one tab per edge leaving this server's environment; none without one */
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
                            </button>
                        ))}
                    </div>
                )}
            </div>
            {edge.targetExists ? (
                <EdgePanel
                    key={edge.target}
                    handle={handle}
                    edge={edge}
                    sourceBranch={branchOf(edge.source)}
                    targetBranch={branchOf(edge.target)}
                    canPromote={canPromote}
                    onOpened={onOpened}
                />
            ) : (
                <p className="rounded-lg border p-4 text-sm text-muted-foreground">
                    The branch <span className="font-mono">{branchOf(edge.target)}</span> of {edge.target} does not exist: turning git on in{' '}
                    {edge.target} creates it. Nothing to promote until then.
                </p>
            )}
        </section>
    );
}

function EdgePanel({
    handle,
    edge,
    sourceBranch,
    targetBranch,
    canPromote,
    onOpened,
}: {
    handle: string;
    edge: EnvironmentEdge;
    sourceBranch: string;
    targetBranch: string;
    canPromote: boolean;
    onOpened: () => void;
}) {
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
                    <PreflightView
                        key={chosen}
                        handle={handle}
                        edge={edge}
                        sha={chosen}
                        sourceBranch={sourceBranch}
                        targetBranch={targetBranch}
                        canPromote={canPromote}
                        onOpened={onOpened}
                    />
                ) : (
                    <p className="text-sm text-muted-foreground">Nothing to promote.</p>
                )}
            </aside>
        </div>
    );
}

function PreflightView({
    handle,
    edge,
    sha,
    sourceBranch,
    targetBranch,
    canPromote,
    onOpened,
}: {
    handle: string;
    edge: EnvironmentEdge;
    sha: string;
    sourceBranch: string;
    targetBranch: string;
    canPromote: boolean;
    onOpened: () => void;
}) {
    const checked = useResource(`preflight:${handle}:${edge.target}:${sha}`, () => getPreflight(handle, edge.target, sha));
    const [opening, setOpening] = useState(false);
    const [opened, setOpened] = useState<{ value?: OpenedPromotion; error?: string } | null>(null);

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
    const open = async () => {
        setOpening(true);
        const answer = await openPromotion(handle, edge.target, sha);
        setOpening(false);
        setOpened(answer.ok ? { value: answer.value } : { error: answer.error.message });
        if (answer.ok) {
            onOpened();
        }
    };
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
                <ul className="grid gap-2">
                    {preflight.blocks.map(block => (
                        <li key={block.kind} className="flex gap-2 text-sm">
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
                    {preflight.blocks.length === 0 && (
                        <li className="flex gap-2 text-sm">
                            <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                            Nothing blocks the promotion.
                        </li>
                    )}
                    {preflight.warnings.map(warning => (
                        <li key={warning.kind} className="flex gap-2 text-sm">
                            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                            <span className="grid gap-1">
                                {warning.message}
                                {warning.items.map(item => (
                                    <span key={item} className="truncate text-xs text-muted-foreground" title={item}>
                                        {item}
                                    </span>
                                ))}
                            </span>
                        </li>
                    ))}
                </ul>
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
                                {p.sha.slice(0, 7)}{' '}
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
                    Up to <span className="font-mono">{sha.slice(0, 12)}</span> of <span className="font-mono">{sourceBranch}</span>, from{' '}
                    <span className="font-mono">
                        promote/{edge.source}-{sha.slice(0, 12)}
                    </span>
                    . Merge it without a squash or a rebase.
                </p>
            </div>
        </>
    );
}

function OpenedView({ opened, targetBranch }: { opened: OpenedPromotion; targetBranch: string }) {
    const { promotion, reused, provider } = opened;
    return (
        <div className="grid gap-2 text-sm">
            <p>
                {reused ? 'This promotion was already open: ' : 'Pushed '}
                <span className="font-mono">{promotion.branch}</span>
                {reused ? '.' : ` at ${promotion.sha.slice(0, 12)}.`}
            </p>
            {promotion.url ? (
                <Button asChild>
                    <a href={promotion.url} target="_blank" rel="noreferrer">
                        <ExternalLink />
                        Open the pull request on {provider ? PROVIDERS[provider] : 'the provider'}
                    </a>
                </Button>
            ) : (
                <p className="text-muted-foreground">
                    Open a pull request from <span className="font-mono">{promotion.branch}</span> into{' '}
                    <span className="font-mono">{targetBranch}</span> on your git provider.
                </p>
            )}
        </div>
    );
}

const Block = ({ title, children }: { title: string; children: ReactNode }) => (
    <div className="grid gap-2">
        <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{title}</h3>
        {children}
    </div>
);
