import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUp, CalendarClock, Check, CircleCheck, GitBranch, GitPullRequestArrow, Info, Layers, Lock, PencilLine, TriangleAlert, Undo2 } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { backport, promote, server } from './actions';
import { CommitGraph } from './commit-graph';
import { aheadOfSource, ancestors, changesBetween, commitsBetween, envOfBranch, mergeBase, parseWorkspace, shortHash, sourceOf, threeWay, type State, type Tree } from './model';
import { useStore } from './store';
import { Pill, prRoute } from './ui';

type Edge = { key: string; from: string; branch: string; to: string | null };

const edgesOf = (state: State): Edge[] =>
    state.envOrder.flatMap(from =>
        state.servers[from]!.settings.promotesTo.map(branch => ({
            key: `${from}>${branch}`,
            from,
            branch,
            to: envOfBranch(state, branch),
        })),
    );

const treeAt = (state: State, sha: string | null | undefined): Tree => (sha ? (state.commits[sha]?.tree ?? {}) : {});

const versionHash = (content: string) => shortHash(content.replace(/^deployed: .*$/m, ''));

function ago(state: State, at: number | undefined): string {
    if (at === undefined) {
        return 'never';
    }
    const minutes = Math.max(0, Math.round((state.clock - at) / 60000));
    if (minutes < 1) {
        return 'just now';
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

const pendingOf = (state: State, edge: Edge) =>
    commitsBetween(state, state.branches[edge.branch], state.branches[state.servers[edge.from]!.settings.branch]);

export function EnvironmentsPage() {
    const { state } = useStore();
    const s = server(state);
    const edges = edgesOf(state);
    const [active, setActive] = useState<string | null>(null);
    const panel = useRef<HTMLDivElement>(null);
    if (!s.gitOn) {
        return <p className="text-sm text-muted-foreground">Git is off on {s.env}.</p>;
    }
    const mine = edges.filter(e => e.from === s.env);
    const current = mine.find(e => e.key === active) ?? mine[0];
    const jump = (key: string) => {
        setActive(key);
        panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    return (
        <div className="grid w-full gap-8">
            <header className="mx-auto w-full max-w-[75rem] grid gap-2">
                <h1 className="text-2xl font-semibold">Environments</h1>
                <p className="max-w-xl text-sm text-muted-foreground">
                    The graph is drawn from every server's settings: who promotes to whom. In this prototype a real server only knows its
                    own settings, so it could not draw this nor know its own source.
                </p>
            </header>

            <section className="grid gap-4">
                <div className="mx-auto w-full max-w-[75rem] flex flex-wrap items-baseline gap-3">
                    <h2 className="font-semibold">Promotion pipeline</h2>
                    <span className="text-xs text-muted-foreground">
                        Click a pending count of {s.env} to jump to that promotion. The others are opened on their own server.
                    </span>
                </div>
                <Pipeline edges={edges} onJump={jump} />
            </section>

            <div ref={panel} className="mx-auto w-full max-w-[75rem] scroll-mt-4">
                {current ? (
                    <PromotePanel key={current.key} edges={mine} edge={current} onPick={setActive} />
                ) : (
                    <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
                        <span className="font-semibold text-foreground">Promote from {s.env}</span>: {s.env} promotes to no environment.
                    </p>
                )}
            </div>

            <div className="mx-auto w-full max-w-[75rem]">
                <RunsWhere />
            </div>

            <div className="mx-auto w-full max-w-[75rem] grid items-start gap-6 lg:grid-cols-2">
                <PrList />
                <Activity />
            </div>
        </div>
    );
}

type Box = { x: number; y: number; w: number; h: number };

function Pipeline({ edges, onJump }: { edges: Edge[]; onJump: (key: string) => void }) {
    const { state } = useStore();
    const inner = useRef<HTMLDivElement>(null);
    const cards = useRef(new Map<string, HTMLDivElement>());
    const [boxes, setBoxes] = useState<Record<string, Box>>({});

    const depth: Record<string, number> = Object.fromEntries(state.envOrder.map(env => [env, 0]));
    for (let pass = 0; pass < state.envOrder.length; pass++) {
        for (const edge of edges) {
            if (edge.to && depth[edge.to]! < depth[edge.from]! + 1 && depth[edge.from]! + 1 < state.envOrder.length) {
                depth[edge.to] = depth[edge.from]! + 1;
            }
        }
    }
    const columns: string[][] = [];
    for (const env of state.envOrder) {
        (columns[depth[env]!] ??= []).push(env);
    }

    useLayoutEffect(() => {
        const measure = () => {
            const origin = inner.current?.getBoundingClientRect();
            if (!origin) {
                return;
            }
            const next: Record<string, Box> = {};
            for (const [env, el] of cards.current) {
                const r = el.getBoundingClientRect();
                next[env] = {
                    x: Math.round(r.left - origin.left),
                    y: Math.round(r.top - origin.top),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                };
            }
            setBoxes(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        };
        measure();
        const observer = new ResizeObserver(measure);
        if (inner.current) {
            observer.observe(inner.current);
        }
        for (const el of cards.current.values()) {
            observer.observe(el);
        }
        return () => observer.disconnect();
    }, [state]);

    const LANE = 26;
    const skipping = edges.filter(edge => edge.to && depth[edge.to]! - depth[edge.from]! !== 1);
    const top = skipping.length ? skipping.length * LANE + 8 : 0;
    const drawn = edges.flatMap(edge => {
        const from = boxes[edge.from];
        const to = edge.to ? boxes[edge.to] : undefined;
        if (!from || !to) {
            return [];
        }
        const x1 = from.x + from.w;
        const y1 = from.y + from.h / 2;
        const x2 = to.x;
        const y2 = to.y + to.h / 2;
        const lane = skipping.indexOf(edge);
        if (lane === -1) {
            const bend = Math.max(40, (x2 - x1) / 2);
            return [{ edge, d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`, x: (x1 + x2) / 2, y: (y1 + y2) / 2 }];
        }
        const y = lane * LANE + LANE / 2;
        const out = x1 + 70;
        const back = x2 - 70;
        return [
            {
                edge,
                d: `M ${x1} ${y1} C ${x1 + 35} ${y1}, ${out - 35} ${y}, ${out} ${y} L ${back} ${y} C ${back + 35} ${y}, ${x2 - 35} ${y2}, ${x2} ${y2}`,
                x: (out + back) / 2,
                y,
            },
        ];
    });

    return (
        <div className="-mx-6 max-h-[44rem] overflow-auto border-y bg-zinc-200 px-6 py-5 dark:bg-zinc-800">
            <div ref={inner} className="relative flex w-max min-w-full items-stretch justify-center gap-40" style={{ paddingTop: top }}>
                <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
                    {drawn.map(({ edge, d }) => (
                        <path key={edge.key} d={d} fill="none" strokeWidth={1.5} strokeDasharray="5 5" className="stroke-amber-500/70" />
                    ))}
                </svg>
                {columns.map((column, i) => (
                    <div key={i} className="flex flex-col justify-center gap-6">
                        {column.map(env => (
                            <EnvCard
                                key={env}
                                env={env}
                                cardRef={el => {
                                    if (el) {
                                        cards.current.set(env, el);
                                    } else {
                                        cards.current.delete(env);
                                    }
                                }}
                            />
                        ))}
                    </div>
                ))}
                {drawn.map(({ edge, x, y }) => {
                    const count = pendingOf(state, edge).length;
                    const pill = cn(
                        'absolute -translate-x-1/2 -translate-y-1/2 rounded-full border bg-card px-2.5 py-0.5 text-xs whitespace-nowrap',
                        count ? 'border-amber-500/60 text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
                    );
                    const label = count ? `${count} to promote` : 'in sync';
                    return edge.from === state.session.env ? (
                        <button
                            key={edge.key}
                            type="button"
                            style={{ left: x, top: y }}
                            className={cn(pill, 'hover:bg-amber-100 dark:hover:bg-amber-950')}
                            onClick={() => onJump(edge.key)}
                        >
                            {label}
                        </button>
                    ) : (
                        <span key={edge.key} style={{ left: x, top: y }} className={pill} title={`Promoted on ${edge.from}'s server`}>
                            {label}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

function EnvCard({ env, cardRef }: { env: string; cardRef?: (el: HTMLDivElement | null) => void }) {
    const { state, act } = useStore();
    const sv = state.servers[env]!;
    const tip = state.branches[sv.settings.branch];
    const source = sourceOf(state, env);
    const sources = state.envOrder.filter(other => other !== env && state.servers[other]!.settings.promotesTo.includes(sv.settings.branch));
    const ahead = aheadOfSource(state, env);
    const behindOf = (other: string) => commitsBetween(state, tip, state.branches[state.servers[other]!.settings.branch]).length;
    const here = state.session.env === env;
    const backportOpen = source && state.prs.find(p => p.state === 'open' && p.kind === 'backport' && p.from === sv.settings.branch);
    const flowsLive = Object.values(sv.flows).filter(f => f.current !== null).length;
    const schedulesOn = Object.values(sv.schedules).filter(x => x.enabled).length;
    const row = 'grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2';
    return (
        <div
            ref={cardRef}
            className={cn(
                'grid w-72 shrink-0 gap-3 rounded-xl border bg-card p-4 text-sm',
                here && 'border-amber-500/70 ring-1 ring-amber-500/40',
            )}
        >
            <div className="flex items-center gap-2">
                <span className="font-semibold">{env}</span>
                {here && <Pill tone="warn">you are here</Pill>}
                <span className="ml-auto">
                    {sv.settings.directEdits ? (
                        <Pill title="A commit on its branch is allowed, and is a deploy">
                            <PencilLine className="size-3" /> direct edits
                        </Pill>
                    ) : (
                        <Pill title="Only a branch and a PR">
                            <Lock className="size-3" /> protected
                        </Pill>
                    )}
                </span>
            </div>
            {sv.gitOn ? (
                <div className="grid gap-1.5">
                    <div className={row}>
                        <span className="text-xs text-muted-foreground">branch</span>
                        <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
                            <GitBranch className="size-3.5 shrink-0" /> <span className="truncate">{sv.settings.branch}</span>
                            <span className="text-muted-foreground">@</span>
                            <span className="rounded bg-muted px-1.5 py-0.5">{tip ?? '-'}</span>
                        </span>
                    </div>
                    <div className={row}>
                        <span className="text-xs text-muted-foreground">reconciled</span>
                        {sv.reconciledSha === tip ? (
                            <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                                <Check className="size-3.5" /> <span className="font-mono">{sv.reconciledSha}</span> up to date
                            </span>
                        ) : (
                            <span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                                <TriangleAlert className="size-3.5" /> <span className="font-mono">{sv.reconciledSha ?? '-'}</span> behind
                                its branch
                            </span>
                        )}
                    </div>
                    <div className={row}>
                        <span className="text-xs text-muted-foreground">source</span>
                        {sources.length ? (
                            <span className="grid gap-1">
                                {sources.map(other => (
                                    <span key={other} className="flex flex-wrap items-center gap-1.5">
                                        <span className="font-medium">{other}</span>
                                        {behindOf(other) > 0 ? <Pill tone="warn">{behindOf(other)} behind</Pill> : <Pill>in sync</Pill>}
                                        {other === source && ahead.length > 0 && <Pill tone="warn">{ahead.length} ahead</Pill>}
                                    </span>
                                ))}
                            </span>
                        ) : (
                            <span className="flex items-center gap-1.5">
                                <span className="font-medium">git provider</span> <Pill>no upstream</Pill>
                            </span>
                        )}
                    </div>
                </div>
            ) : (
                <Pill tone="warn" className="justify-self-start">
                    git off: flows only in this server's Postgres
                </Pill>
            )}
            {ahead.length > 0 && source && (
                <div className="grid gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                        <TriangleAlert className="size-3.5" /> Ahead of {source} by {ahead.length} commit{ahead.length === 1 ? '' : 's'}
                    </span>
                    {backportOpen ? (
                        <Link className="text-xs text-primary underline" to={prRoute(backportOpen.number)}>
                            Backport PR !{backportOpen.number} open
                        </Link>
                    ) : here ? (
                        <Button size="sm" className="justify-self-start" onClick={() => act(d => backport(d, env))}>
                            <Undo2 /> Backport
                        </Button>
                    ) : (
                        <span className="text-xs text-muted-foreground">The backport is offered on {env}'s server.</span>
                    )}
                    {ahead.slice(0, 3).map(c => (
                        <span key={c.sha} className="text-xs text-muted-foreground">
                            <span className="font-mono">{c.sha}</span> {c.message}
                        </span>
                    ))}
                </div>
            )}
            <div className="grid gap-1.5 border-t pt-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-4">
                    <span className="flex items-center gap-1.5">
                        <Layers className="size-3.5" /> {flowsLive} flow{flowsLive === 1 ? '' : 's'} live
                    </span>
                    <span className="flex items-center gap-1.5">
                        <CalendarClock className="size-3.5" /> {schedulesOn} schedule{schedulesOn === 1 ? '' : 's'} on
                    </span>
                </span>
                <span className="flex items-center gap-1.5">
                    <ArrowUp className="size-3.5" /> deployed{' '}
                    {ago(state, sv.reconciledSha ? state.commits[sv.reconciledSha]?.at : undefined)}
                </span>
            </div>
        </div>
    );
}

type Preflight = { tone: 'ok' | 'warn' | 'info'; text: ReactNode };

function PromotePanel({ edges, edge, onPick }: { edges: Edge[]; edge: Edge; onPick: (key: string) => void }) {
    const { state, act } = useStore();
    const [picked, setPicked] = useState<string | null>(null);
    const src = state.servers[edge.from]!;
    const sourceBranch = src.settings.branch;
    const tip = state.branches[sourceBranch]!;
    const targetTip = state.branches[edge.branch];
    const target = edge.to ? state.servers[edge.to]! : null;
    const targetName = edge.to ?? edge.branch;
    const pending = pendingOf(state, edge);
    const chosen = picked && pending.some(c => c.sha === picked) ? picked : tip;
    const contained = ancestors(state, chosen);
    const going = pending.filter(c => contained.has(c.sha));
    const base = targetTip ? mergeBase(state, targetTip, chosen) : null;
    const merged = targetTip
        ? threeWay(treeAt(state, base), treeAt(state, targetTip), treeAt(state, chosen))
        : { tree: treeAt(state, chosen), conflicts: [] };
    const files = changesBetween(treeAt(state, targetTip), merged.tree).length;
    const view = parseWorkspace(merged.tree);
    const open = state.prs.find(p => p.state === 'open' && p.kind === 'promotion' && p.to === edge.branch);

    const checks: Preflight[] = [];
    checks.push(
        merged.conflicts.length
            ? { tone: 'warn', text: `${merged.conflicts.length} file(s) conflict with ${edge.branch}: the PR cannot be merged as it is.` }
            : { tone: 'ok', text: `No merge conflicts with ${edge.branch}` },
    );
    const targetAhead = edge.to && sourceOf(state, edge.to) === edge.from ? aheadOfSource(state, edge.to) : [];
    if (targetAhead.length) {
        checks.push({
            tone: 'warn',
            text: (
                <>
                    <b>{targetName}</b> is ahead of {edge.from} by {targetAhead.length} commit(s) not back-ported: after this promotion they
                    still differ.
                </>
            ),
        });
    }
    if (target) {
        for (const decl of view.connections.filter(c => !target.connections[c.id]?.configured)) {
            checks.push({
                tone: 'warn',
                text: (
                    <>
                        The <b>{decl.name}</b> connection is not configured on {targetName}. Flows that use it deploy, and fail at that
                        component until it is.
                    </>
                ),
            });
        }
        const arriving = view.flows.flatMap(f => f.doc.schedules ?? []).filter(x => !target.schedules[x.id]).length;
        if (arriving) {
            checks.push({
                tone: 'info',
                text: `${arriving} new schedule(s) arrive disabled on ${targetName} until someone there enables them.`,
            });
        }
    }
    const direct = going.filter(c => c.kind === 'outside').length;
    if (direct) {
        checks.push({ tone: 'info', text: `${direct} of these commits came straight from a push to git, without a PR.` });
    }
    const drafts = Object.keys(src.working[sourceBranch] ?? {}).length;
    if (drafts) {
        checks.push({ tone: 'info', text: `${drafts} uncommitted change(s) on ${sourceBranch} stay behind: drafts never go.` });
    }
    checks.push({
        tone: 'info',
        text:
            target && !target.settings.directEdits
                ? `${targetName} is protected: this goes through a PR on the provider.`
                : 'A promotion is always a PR on the provider.',
    });

    const impact = [
        ...view.flows.map(flow => {
            const row = target?.flows[flow.id];
            const last = row?.versions.at(-1);
            const hash = versionHash(merged.tree[flow.path]!);
            const next = !last ? 1 : last.hash !== hash ? row!.versions.length + 1 : last.n;
            const before = !row ? 'new' : row.current === null ? 'not running' : `v${row.current}`;
            const after = flow.doc.deployed ? `v${next}` : 'not running';
            return { id: flow.id, name: flow.name, before, after, changed: before !== after };
        }),
        ...Object.values(target?.flows ?? {})
            .filter(row => row.current !== null && !view.flows.some(f => f.id === row.id))
            .map(row => ({ id: row.id, name: row.name, before: `v${row.current}`, after: 'removed', changed: true })),
    ];

    return (
        <section className="overflow-hidden rounded-xl border bg-card">
            <div className="grid lg:grid-cols-[minmax(0,1fr)_21rem]">
                <div className="grid min-w-0 grid-rows-[auto_auto_minmax(0,1fr)]">
                    <div className="flex flex-wrap items-center gap-3 border-b p-4">
                        <h2 className="font-semibold">Promote from {edge.from}</h2>
                        <div className="flex flex-wrap rounded-lg border p-0.5">
                            {edges.map(e => {
                                const count = pendingOf(state, e).length;
                                return (
                                    <button
                                        key={e.key}
                                        type="button"
                                        className={cn(
                                            'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs',
                                            e.key === edge.key ? 'bg-muted font-semibold' : 'text-muted-foreground hover:text-foreground',
                                        )}
                                        onClick={() => onPick(e.key)}
                                    >
                                        {e.from} <ArrowRight className="size-3" /> {e.to ?? e.branch}
                                        <span
                                            className={cn(
                                                'rounded px-1 font-mono text-[10px]',
                                                count
                                                    ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                                                    : 'bg-muted text-muted-foreground',
                                            )}
                                        >
                                            {count}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {pending.length === 0 ? (
                        <p className="p-4 text-sm text-muted-foreground">
                            <span className="font-mono">{edge.branch}</span> has everything committed on{' '}
                            <span className="font-mono">{sourceBranch}</span>.
                        </p>
                    ) : (
                        <>
                            <p className="border-b px-4 py-3 text-xs text-muted-foreground">
                                The chosen commit goes with everything it contains: follow the lines down from it. What stays behind is
                                dimmed. A hollow dot is a merge; a commit off the first line came in through a merge and cannot be chosen on
                                its own.
                            </p>
                            <div className="max-h-[34rem] overflow-y-auto">
                                <CommitGraph
                                    state={state}
                                    commits={pending}
                                    tip={tip}
                                    chosen={chosen}
                                    branch={sourceBranch}
                                    onChoose={setPicked}
                                />
                            </div>
                        </>
                    )}
                </div>

                <aside className="grid content-start gap-5 border-t p-4 lg:border-t-0 lg:border-l">
                    <div className="grid gap-2">
                        <Heading>Selection</Heading>
                        <div className="grid grid-cols-3 gap-2">
                            <Stat value={going.length} label="commits" />
                            <Stat value={new Set(going.map(c => c.author)).size} label="authors" />
                            <Stat value={files} label="files" />
                        </div>
                    </div>
                    <div className="grid gap-2">
                        <Heading>Pre-flight</Heading>
                        <ul className="grid gap-2.5">
                            {checks.map((check, i) => (
                                <li key={i} className="flex gap-2 text-sm">
                                    {check.tone === 'ok' ? (
                                        <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                                    ) : check.tone === 'warn' ? (
                                        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                                    ) : (
                                        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                                    )}
                                    <span>{check.text}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                    <div className="grid gap-2">
                        <Heading>Impact on {targetName}</Heading>
                        {!target ? (
                            <p className="text-xs text-muted-foreground">No server runs {edge.branch}.</p>
                        ) : !target.gitOn ? (
                            <p className="text-xs text-muted-foreground">
                                Git is off on {targetName}: nothing is deployed there by a merge.
                            </p>
                        ) : (
                            <ul className="grid gap-1">
                                {impact.map(row => (
                                    <li key={row.id} className="flex items-center gap-2 rounded-md bg-muted/50 px-2.5 py-1.5 text-sm">
                                        <span
                                            className={cn('min-w-0 flex-1 truncate', row.changed ? 'font-medium' : 'text-muted-foreground')}
                                        >
                                            {row.name}
                                        </span>
                                        {row.changed ? (
                                            <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
                                                <span className="text-muted-foreground">{row.before}</span>
                                                <ArrowRight className="size-3 text-muted-foreground" />
                                                <span className="font-semibold text-amber-600 dark:text-amber-400">{row.after}</span>
                                            </span>
                                        ) : (
                                            <span className="shrink-0 text-xs text-muted-foreground">unchanged</span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div className="grid gap-2">
                        {open ? (
                            <Button asChild variant="outline">
                                <Link to={prRoute(open.number)}>
                                    <GitPullRequestArrow /> Promotion PR !{open.number} is open
                                </Link>
                            </Button>
                        ) : (
                            <Button
                                disabled={pending.length === 0}
                                onClick={() => act(d => promote(d, edge.branch, chosen))}
                                className="bg-amber-500 text-black hover:bg-amber-400"
                            >
                                <GitPullRequestArrow /> Open a promotion PR
                            </Button>
                        )}
                        <p className="text-center text-xs text-muted-foreground">
                            {chosen === tip ? (
                                <>
                                    everything on <span className="font-mono">{sourceBranch}</span>
                                </>
                            ) : (
                                <>
                                    up to <span className="font-mono">{chosen}</span>, from{' '}
                                    <span className="font-mono">
                                        promote/{sourceBranch}-{chosen}
                                    </span>
                                </>
                            )}
                        </p>
                        <Button variant="outline" disabled={chosen === tip} onClick={() => setPicked(null)}>
                            Reset to tip
                        </Button>
                    </div>
                </aside>
            </div>
        </section>
    );
}

const Heading = ({ children }: { children: ReactNode }) => (
    <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{children}</h3>
);

const Stat = ({ value, label }: { value: number; label: string }) => (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
        <div className="text-xl font-semibold">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
    </div>
);

type Cell = { sig: string; node: ReactNode };
type Line = { key: string; label: ReactNode; cells: Cell[] };

function RunsWhere() {
    const { state, act } = useStore();
    const [onlyDiff, setOnlyDiff] = useState(false);
    const here = state.session.env;
    const hereIndex = state.envOrder.indexOf(here);
    const none: Cell = { sig: 'none', node: <span className="text-xs text-muted-foreground">-</span> };

    const flowNames = new Map<string, string>();
    const scheduleLabels = new Map<string, { name: string; cron: string }>();
    const connectionNames = new Map<string, string>();
    for (const env of state.envOrder) {
        const sv = state.servers[env]!;
        for (const row of Object.values(sv.flows)) {
            flowNames.set(row.id, row.name);
        }
        for (const row of Object.values(sv.connections)) {
            connectionNames.set(row.id, row.name);
        }
        for (const flow of parseWorkspace(treeAt(state, state.branches[sv.settings.branch])).flows) {
            for (const sc of flow.doc.schedules ?? []) {
                scheduleLabels.set(sc.id, { name: `${flow.name} · ${sc.name}`, cron: sc.cron });
            }
        }
    }

    const flows: Line[] = [...flowNames].map(([id, name]) => ({
        key: id,
        label: <span className="font-medium">{name}</span>,
        cells: state.envOrder.map(env => {
            const row = state.servers[env]!.flows[id];
            if (!row) {
                return none;
            }
            if (row.current === null) {
                return { sig: 'off', node: <span className="text-muted-foreground">not running</span> };
            }
            const v = row.versions.find(x => x.n === row.current);
            return {
                sig: v?.hash ?? 'unknown',
                node: (
                    <span className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold">v{row.current}</span>
                        <span className="font-mono text-xs text-muted-foreground">{v?.sha ?? '-'}</span>
                    </span>
                ),
            };
        }),
    }));

    const schedules: Line[] = [...scheduleLabels].map(([id, label]) => ({
        key: id,
        label: (
            <span className="flex items-center gap-2">
                <span className="font-medium">{label.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{label.cron}</span>
            </span>
        ),
        cells: state.envOrder.map(env => {
            const row = state.servers[env]!.schedules[id];
            if (!row) {
                return none;
            }
            const overridden = Object.keys(row.override).length > 0;
            return {
                sig: row.enabled ? 'on' : 'off',
                node: (
                    <span className="flex items-center gap-1.5">
                        <button
                            type="button"
                            title={env === here ? 'Toggle' : `Only on ${env}'s server`}
                            disabled={env !== here}
                            className={cn(
                                'flex items-center gap-1.5 text-xs',
                                row.enabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
                            )}
                            onClick={() => act(d => void (d.servers[env]!.schedules[id]!.enabled = !row.enabled))}
                        >
                            <span className={cn('size-1.5 rounded-full', row.enabled ? 'bg-emerald-500' : 'bg-muted-foreground')} />
                            {row.enabled ? 'enabled' : 'disabled'}
                        </button>
                        {overridden && (
                            <Pill tone="info" title={JSON.stringify(row.override)}>
                                override
                            </Pill>
                        )}
                    </span>
                ),
            };
        }),
    }));

    const connections: Line[] = [...connectionNames].map(([id, name]) => ({
        key: id,
        label: <span className="font-medium">{name}</span>,
        cells: state.envOrder.map(env => {
            const row = state.servers[env]!.connections[id];
            if (!row) {
                return none;
            }
            return {
                sig: row.configured ? 'configured' : 'missing',
                node: (
                    <span
                        className={cn(
                            'flex items-center gap-1.5 text-xs',
                            row.configured ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
                        )}
                    >
                        <span className={cn('size-1.5 rounded-full', row.configured ? 'bg-emerald-500' : 'bg-amber-500')} />
                        {row.configured ? 'configured' : 'not configured'}
                    </span>
                ),
            };
        }),
    }));

    const differs = (line: Line) => line.cells.some(cell => cell.sig !== line.cells[hereIndex]!.sig);
    const groups = [
        { title: 'Flows', lines: flows },
        { title: 'Schedules', lines: schedules },
        { title: 'Connections', lines: connections },
    ];
    const differing = groups.flatMap(g => g.lines).filter(differs).length;

    return (
        <section className="grid gap-3">
            <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-semibold">What runs where</h2>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className={cn('size-1.5 rounded-full', differing ? 'bg-amber-500' : 'bg-emerald-500')} />
                    {differing ? `${differing} row${differing === 1 ? '' : 's'} differ from ${here}` : `Everything matches ${here}`}
                </span>
                <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <Switch checked={onlyDiff} onCheckedChange={setOnlyDiff} /> Only rows that differ
                </label>
            </div>
            <div className="overflow-x-auto rounded-xl border bg-card">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b text-left text-[11px] tracking-wider text-muted-foreground uppercase">
                            <th className="px-4 py-2.5 font-medium">Flow</th>
                            {state.envOrder.map(env => (
                                <th
                                    key={env}
                                    className={cn('px-4 py-2.5 font-medium', env === here && 'text-amber-600 dark:text-amber-400')}
                                >
                                    {env}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    {groups.map(group => {
                        const lines = group.lines.filter(line => !onlyDiff || differs(line));
                        return lines.length === 0 ? null : (
                            <tbody key={group.title}>
                                <tr className="border-b bg-muted/40">
                                    <td
                                        colSpan={state.envOrder.length + 1}
                                        className="px-4 py-1.5 text-[11px] tracking-wider text-muted-foreground uppercase"
                                    >
                                        {group.title}
                                    </td>
                                </tr>
                                {lines.map(line => (
                                    <tr key={line.key} className="border-b last:border-b-0">
                                        <td className="px-4 py-2.5">{line.label}</td>
                                        {line.cells.map((cell, i) => (
                                            <td key={state.envOrder[i]} className="px-4 py-2.5">
                                                <span className="flex items-center gap-2">
                                                    {cell.sig !== line.cells[hereIndex]!.sig && (
                                                        <span
                                                            className="size-1.5 shrink-0 rounded-full bg-amber-500"
                                                            title={`Differs from ${here}`}
                                                        />
                                                    )}
                                                    {cell.node}
                                                </span>
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        );
                    })}
                </table>
            </div>
        </section>
    );
}

function PrList() {
    const { state } = useStore();
    const prs = state.prs.slice().reverse();
    return (
        <section className="grid gap-3">
            <div className="flex items-baseline gap-3">
                <h2 className="font-semibold">Pull requests</h2>
                <span className="text-xs text-muted-foreground">on the provider</span>
            </div>
            {prs.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
            <div className="grid gap-2">
                {prs.map(p => (
                    <Link
                        key={p.number}
                        to={prRoute(p.number)}
                        className="grid gap-1 rounded-xl border bg-card px-4 py-3 hover:bg-muted/50"
                    >
                        <span className="flex items-center gap-2 text-sm">
                            <GitPullRequestArrow className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate font-medium">
                                !{p.number} {p.title}
                            </span>
                            <span className="ml-auto flex shrink-0 gap-1.5">
                                <Pill tone={p.state === 'open' ? 'info' : p.state === 'merged' ? 'ok' : 'muted'}>{p.state}</Pill>
                                <Pill>{p.kind}</Pill>
                            </span>
                        </span>
                        <span className="truncate pl-6 font-mono text-xs text-muted-foreground">
                            {p.from} → {p.to} · {state.users.find(u => u.slug === p.author)?.name ?? p.author}
                        </span>
                    </Link>
                ))}
            </div>
        </section>
    );
}

function Activity() {
    const { state } = useStore();
    return (
        <section className="grid gap-3">
            <div className="flex items-baseline gap-3">
                <h2 className="font-semibold">Activity</h2>
                <span className="text-xs text-muted-foreground">across all environments</span>
            </div>
            <ul className="max-h-96 divide-y overflow-y-auto rounded-xl border bg-card">
                {state.events.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">Nothing yet.</li>}
                {state.events.slice(0, 20).map(event => (
                    <li key={event.id} className="flex gap-3 px-4 py-3 text-sm">
                        {event.tone === 'ok' ? (
                            <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                        ) : event.tone === 'info' ? (
                            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        ) : (
                            <TriangleAlert
                                className={cn('mt-0.5 size-4 shrink-0', event.tone === 'error' ? 'text-red-500' : 'text-amber-500')}
                            />
                        )}
                        <span className="min-w-0 flex-1">{event.text}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{ago(state, event.at)}</span>
                    </li>
                ))}
            </ul>
        </section>
    );
}
