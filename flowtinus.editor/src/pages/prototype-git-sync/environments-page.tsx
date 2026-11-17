import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUp, CalendarClock, Check, CircleCheck, CircleX, GitBranch, GitPullRequestArrow, Info, Layers, Lock, PencilLine, Pin, ShieldAlert, TriangleAlert, Undo2, Wrench } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { promote, promotionBlockers, repairLineage, server, startBackport } from './actions';
import { CommitGraph } from './commit-graph';
import { aheadFiles, ancestors, branchOf, brokenLineage, changesBetween, commitsBetween, CONFIG_BRANCH, labelOf, mergeBase, mergeTrees, modeOf, parseWorkspace, rootOf, sourceOf, topology, treeAt, validateTree, versionHash, type Mode, type State } from './model';
import { useStore } from './store';
import { BASE, Pill, prRoute } from './ui';

type Edge = { key: string; from: string; to: string; branch: string };

const envsOf = (state: State) => topology(state).filter(e => state.servers[e.env]);

const edgesOf = (state: State): Edge[] =>
    envsOf(state).flatMap(from =>
        from.promotesTo
            .filter(to => state.servers[to])
            .map(to => ({ key: `${from.env}>${to}`, from: from.env, to, branch: branchOf(state, to) })),
    );

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
    commitsBetween(state, state.branches[edge.branch], state.branches[branchOf(state, edge.from)]);

/** what a promotion of `sha` would change in the target: files, not commits */
function promotionResult(state: State, edge: Edge, sha: string | undefined) {
    const targetTip = state.branches[edge.branch];
    if (!sha) {
        return { tree: treeAt(state, targetTip), conflicts: [], files: [] as ReturnType<typeof changesBetween> };
    }
    const base = targetTip ? mergeBase(state, targetTip, sha) : null;
    const merged = targetTip
        ? mergeTrees(treeAt(state, base), treeAt(state, targetTip), treeAt(state, sha))
        : { tree: treeAt(state, sha), conflicts: [] };
    return { ...merged, files: changesBetween(treeAt(state, targetTip), merged.tree) };
}

const MODE: Record<Mode, { label: string; title: string; icon: typeof Lock }> = {
    direct: { label: 'direct', title: 'Edits straight in the editor (a commit is a deploy), and pull requests', icon: PencilLine },
    'pull-request': { label: 'pull request', title: 'Only pull requests from work branches', icon: GitPullRequestArrow },
    protected: { label: 'protected', title: 'Only promotion and hotfix pull requests', icon: Lock },
};

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
            <header className="mx-auto grid w-full max-w-[75rem] gap-2">
                <h1 className="text-2xl font-semibold">Environments</h1>
                <p className="max-w-2xl text-sm text-muted-foreground">
                    The pipeline is <span className="font-mono">topology.yaml</span> on <span className="font-mono">{CONFIG_BRANCH}</span>:
                    every server reads the same file, so each one knows its source, its targets and the others' labels.
                </p>
            </header>

            <section className="grid gap-4">
                <div className="mx-auto flex w-full max-w-[75rem] flex-wrap items-baseline gap-3">
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

            <div className="mx-auto grid w-full max-w-[75rem] items-start gap-6 lg:grid-cols-2">
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
    const envs = envsOf(state).map(e => e.env);

    const depth: Record<string, number> = Object.fromEntries(envs.map(env => [env, 0]));
    for (let pass = 0; pass < envs.length; pass++) {
        for (const edge of edges) {
            if (depth[edge.to]! < depth[edge.from]! + 1 && depth[edge.from]! + 1 < envs.length) {
                depth[edge.to] = depth[edge.from]! + 1;
            }
        }
    }
    const columns: string[][] = [];
    for (const env of envs) {
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

    const drawn = edges.flatMap(edge => {
        const from = boxes[edge.from];
        const to = boxes[edge.to];
        if (!from || !to) {
            return [];
        }
        const x1 = from.x + from.w;
        const y1 = from.y + from.h / 2;
        const x2 = to.x;
        const y2 = to.y + to.h / 2;
        const bend = Math.max(40, (x2 - x1) / 2);
        return [{ edge, d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`, x: (x1 + x2) / 2, y: (y1 + y2) / 2 }];
    });

    return (
        <div className="-mx-6 max-h-[48rem] overflow-auto border-y bg-zinc-200 px-6 py-5 dark:bg-zinc-800">
            <div ref={inner} className="relative flex w-max min-w-full items-stretch justify-center gap-40">
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
                    const files = pendingOf(state, edge).length
                        ? promotionResult(state, edge, state.branches[branchOf(state, edge.from)]).files.length
                        : 0;
                    const blocked = promotionBlockers(state, edge.from, edge.to).length > 0;
                    const pill = cn(
                        'absolute -translate-x-1/2 -translate-y-1/2 rounded-full border bg-card px-2.5 py-0.5 text-xs whitespace-nowrap',
                        blocked
                            ? 'border-red-500/60 text-red-600 dark:text-red-400'
                            : files
                              ? 'border-amber-500/60 text-amber-600 dark:text-amber-400'
                              : 'text-muted-foreground',
                    );
                    const label = blocked ? 'blocked' : files ? `${files} file${files === 1 ? '' : 's'} to promote` : 'in sync';
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
    const navigate = useNavigate();
    const sv = state.servers[env]!;
    const branch = branchOf(state, env);
    const tip = state.branches[branch];
    const source = sourceOf(state, env);
    const root = rootOf(state, env);
    const ahead = aheadFiles(state, env);
    const broken = brokenLineage(state, env);
    const behind = source ? commitsBetween(state, tip, state.branches[branchOf(state, source)]).length : 0;
    const here = state.session.env === env;
    const backportOpen = state.prs.find(p => p.state === 'open' && p.kind === 'backport' && p.from.startsWith(`backport/${branch}-`));
    const repairOpen = state.prs.find(p => p.state === 'open' && p.to === branch && p.from.endsWith('-repair'));
    const flowsLive = Object.values(sv.flows).filter(f => f.current !== null).length;
    const schedulesOn = Object.values(sv.schedules).filter(x => x.enabled).length;
    const schedulesOff = Object.values(sv.schedules).length - schedulesOn;
    const pins = Object.keys(sv.pins).length;
    const mode = MODE[modeOf(state, env)];
    const row = 'grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2';
    return (
        <div
            ref={cardRef}
            className={cn(
                'grid w-80 shrink-0 gap-3 rounded-xl border bg-card p-4 text-sm',
                here && 'border-amber-500/70 ring-1 ring-amber-500/40',
            )}
        >
            <div className="flex items-center gap-2">
                <span className="font-semibold">{env}</span>
                <span className="truncate text-xs text-muted-foreground">{labelOf(state, env)}</span>
                {here && <Pill tone="warn">you are here</Pill>}
                <span className="ml-auto">
                    <Pill title={mode.title}>
                        <mode.icon className="size-3" /> {mode.label}
                    </Pill>
                </span>
            </div>
            {sv.gitOn ? (
                <div className="grid gap-1.5">
                    <div className={row}>
                        <span className="text-xs text-muted-foreground">branch</span>
                        <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
                            <GitBranch className="size-3.5 shrink-0" /> <span className="truncate">{branch}</span>
                            <span className="text-muted-foreground">@</span>
                            <span className="rounded bg-muted px-1.5 py-0.5">{tip ?? '-'}</span>
                        </span>
                    </div>
                    <div className={row}>
                        <span className="text-xs text-muted-foreground">deployed</span>
                        {sv.reconciledSha === tip ? (
                            <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                                <Check className="size-3.5" /> <span className="font-mono">{sv.reconciledSha}</span> same as git
                            </span>
                        ) : (
                            <span className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                                <TriangleAlert className="size-3.5" /> <span className="font-mono">{sv.reconciledSha ?? '-'}</span> git is
                                ahead
                            </span>
                        )}
                    </div>
                    <div className={row}>
                        <span className="text-xs text-muted-foreground">source</span>
                        {source ? (
                            <span className="flex flex-wrap items-center gap-1.5">
                                <span className="font-medium">{source}</span>
                                {behind > 0 ? <Pill tone="warn">{behind} behind</Pill> : <Pill>in sync</Pill>}
                                {ahead.length > 0 && <Pill tone="bad">ahead</Pill>}
                            </span>
                        ) : (
                            <span className="flex items-center gap-1.5">
                                <span className="font-medium">work branches</span> <Pill>root</Pill>
                            </span>
                        )}
                    </div>
                </div>
            ) : (
                <Pill tone="warn" className="justify-self-start">
                    git off: flows only in this server's Postgres
                </Pill>
            )}
            {sv.gitOn && sv.refused && sv.refused.sha === tip && (
                <div className="grid gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 p-3">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-300">
                        <CircleX className="size-3.5" /> Git is at {sv.refused.sha}, the deploy stays at {sv.reconciledSha ?? '-'}
                    </span>
                    {sv.refused.errors.map(error => (
                        <span key={error} className="text-xs text-muted-foreground">
                            {error}
                        </span>
                    ))}
                    <span className="text-xs text-muted-foreground">An invalid tree is never applied: the next commit is tried again.</span>
                </div>
            )}
            {broken && (
                <div className="grid gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-300">
                        <ShieldAlert className="size-3.5" /> Lineage broken: !{broken.number} was{' '}
                        {broken.method === 'squash' ? 'squashed' : 'rebased'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        <span className="font-mono">{broken.promotedSha}</span> is not an ancestor of {branch}. Promotions into and out of{' '}
                        {env} are blocked until a repair: a commit with both parents and the promoted tree.
                    </span>
                    {repairOpen ? (
                        <Link className="text-xs text-primary underline" to={prRoute(repairOpen.number)}>
                            Repair PR !{repairOpen.number} open
                        </Link>
                    ) : state.session.env === source ? (
                        <Button size="sm" className="justify-self-start" onClick={() => act(d => repairLineage(d, env))}>
                            <Wrench /> Open the repair PR
                        </Button>
                    ) : (
                        <span className="text-xs text-muted-foreground">
                            The repair is opened on {source}'s server, which promotes here.
                        </span>
                    )}
                </div>
            )}
            {ahead.length > 0 && source && (
                <div className="grid gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                        <TriangleAlert className="size-3.5" /> Ahead of {source}: {ahead.length} file{ahead.length === 1 ? '' : 's'} not
                        back-ported
                    </span>
                    <span className="text-xs text-muted-foreground">
                        {source} → {env} is blocked until the change is back in {source}. The backport goes one hop: {env} into {source}
                        {source !== root && `, then ${source} into its own source, up to ${root}`}. Nothing else comes along.
                    </span>
                    {backportOpen ? (
                        <Link className="text-xs text-primary underline" to={prRoute(backportOpen.number)}>
                            Backport PR !{backportOpen.number} open
                        </Link>
                    ) : state.session.env === source ? (
                        <Button
                            size="sm"
                            className="justify-self-start"
                            onClick={() => {
                                const result = act(d => startBackport(d, env));
                                if (!result.error) {
                                    navigate(`${BASE}/changes?variant=${state.session.variant}`);
                                }
                            }}
                        >
                            <Undo2 /> Back-port into {source}
                        </Button>
                    ) : (
                        <span className="text-xs text-muted-foreground">The backport is opened on {source}'s server.</span>
                    )}
                    {ahead.slice(0, 3).map(path => (
                        <span key={path} className="truncate font-mono text-xs text-muted-foreground">
                            {path.split('/').slice(-2).join('/')}
                        </span>
                    ))}
                </div>
            )}
            <div className="grid gap-1.5 border-t pt-3 text-xs text-muted-foreground">
                <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="flex items-center gap-1.5">
                        <Layers className="size-3.5" /> {flowsLive} flow{flowsLive === 1 ? '' : 's'} live
                    </span>
                    <span
                        className="flex items-center gap-1.5"
                        title="A schedule arrives disabled everywhere, until someone here enables it"
                    >
                        <CalendarClock className="size-3.5" /> {schedulesOn} on{schedulesOff ? `, ${schedulesOff} disabled` : ''}
                    </span>
                    {pins > 0 && (
                        <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                            <Pin className="size-3.5" /> {pins} pinned
                        </span>
                    )}
                </span>
                <span className="flex items-center gap-1.5">
                    <ArrowUp className="size-3.5" /> deployed{' '}
                    {ago(state, sv.reconciledSha ? state.commits[sv.reconciledSha]?.at : undefined)}
                </span>
            </div>
        </div>
    );
}

type Preflight = { tone: 'ok' | 'warn' | 'info' | 'bad'; text: ReactNode };

function PromotePanel({ edges, edge, onPick }: { edges: Edge[]; edge: Edge; onPick: (key: string) => void }) {
    const { state, act } = useStore();
    const [picked, setPicked] = useState<string | null>(null);
    const [error, setError] = useState('');
    const src = state.servers[edge.from]!;
    const sourceBranch = branchOf(state, edge.from);
    const tip = state.branches[sourceBranch]!;
    const target = state.servers[edge.to]!;
    const pending = pendingOf(state, edge);
    const chosen = picked && pending.some(c => c.sha === picked) ? picked : tip;
    const contained = ancestors(state, chosen);
    const going = pending.filter(c => contained.has(c.sha));
    const merged = promotionResult(state, edge, chosen);
    const view = parseWorkspace(merged.tree);
    const open = state.prs.find(p => p.state === 'open' && p.kind === 'promotion' && p.to === edge.branch);
    const blockers = promotionBlockers(state, edge.from, edge.to);
    const invalid = merged.conflicts.length ? [] : validateTree(merged.tree);

    const checks: Preflight[] = [];
    for (const blocker of blockers) {
        checks.push({ tone: 'bad', text: blocker });
    }
    checks.push(
        merged.conflicts.length
            ? {
                  tone: 'bad',
                  text: `${merged.conflicts.length} conflict(s) with ${edge.branch}: a promotion never conflicts once the target is back-ported.`,
              }
            : { tone: 'ok', text: `No conflicts with ${edge.branch}` },
    );
    checks.push(
        invalid.length
            ? { tone: 'bad', text: `The result is not valid: ${invalid.join(' ')} ${edge.to} would refuse it.` }
            : { tone: 'ok', text: 'The result passes the validation' },
    );
    for (const decl of view.connections.filter(c => !target.connections[c.id]?.configured)) {
        checks.push({
            tone: 'warn',
            text: (
                <>
                    The <b>{decl.name}</b> connection is not configured on {edge.to}. Flows that use it deploy, and fail at that component
                    until it is.
                </>
            ),
        });
    }
    const arriving = view.flows.flatMap(f => f.doc.schedules ?? []).filter(x => !target.schedules[x.id]).length;
    if (arriving) {
        checks.push({ tone: 'info', text: `${arriving} new schedule(s) arrive disabled on ${edge.to} until someone there enables them.` });
    }
    const direct = going.filter(c => c.kind === 'outside').length;
    if (direct) {
        checks.push({ tone: 'info', text: `${direct} of these commits came straight from a push to git, without a PR.` });
    }
    const drafts = Object.keys(src.working[sourceBranch] ?? {}).length;
    if (drafts) {
        checks.push({ tone: 'info', text: `${drafts} uncommitted change(s) on ${sourceBranch} stay behind: drafts never go.` });
    }

    const impact = [
        ...view.flows.map(flow => {
            const row = target.flows[flow.id];
            const last = row?.versions.at(-1);
            const hash = versionHash(merged.tree[flow.path]!);
            const next = !last ? 1 : last.hash !== hash ? row!.versions.length + 1 : last.n;
            const before = !row ? 'new' : row.current === null ? 'not running' : `v${row.current}`;
            const after = flow.doc.deployed === false ? 'not running' : `v${next}`;
            return { id: flow.id, name: flow.name, before, after, changed: before !== after };
        }),
        ...Object.values(target.flows)
            .filter(row => row.current !== null && !view.flows.some(f => f.id === row.id))
            .map(row => ({ id: row.id, name: row.name, before: `v${row.current}`, after: 'removed', changed: true })),
    ];
    const canOpen = pending.length > 0 && blockers.length === 0 && merged.conflicts.length === 0 && invalid.length === 0;

    return (
        <section className="overflow-hidden rounded-xl border bg-card">
            <div className="grid lg:grid-cols-[minmax(0,1fr)_22rem]">
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
                                        {e.from} <ArrowRight className="size-3" /> {e.to}
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
                            <Stat value={merged.files.length} label="files" />
                            <Stat value={going.length} label="commits" />
                            <Stat value={new Set(going.map(c => c.author)).size} label="authors" />
                        </div>
                    </div>
                    <div className="grid gap-2">
                        <Heading>Pre-flight</Heading>
                        <ul className="grid gap-2.5">
                            {checks.map((check, i) => (
                                <li key={i} className="flex gap-2 text-sm">
                                    {check.tone === 'ok' ? (
                                        <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                                    ) : check.tone === 'bad' ? (
                                        <CircleX className="mt-0.5 size-4 shrink-0 text-red-500" />
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
                        <Heading>Impact on {edge.to}</Heading>
                        {!target.gitOn ? (
                            <p className="text-xs text-muted-foreground">Git is off on {edge.to}: nothing is deployed there by a merge.</p>
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
                        <p className="text-xs text-muted-foreground">
                            Version numbers are {edge.to}'s own; the sha is what both environments share.
                        </p>
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
                                disabled={!canOpen}
                                onClick={() => setError(act(d => promote(d, edge.to, chosen)) ?? '')}
                                className="bg-amber-500 text-black hover:bg-amber-400"
                            >
                                <GitPullRequestArrow /> Open a promotion PR
                            </Button>
                        )}
                        {error && <p className="text-sm text-destructive">{error}</p>}
                        <p className="text-center text-xs text-muted-foreground">
                            up to <span className="font-mono">{chosen}</span>
                            {chosen === tip && ' (the tip)'}, from{' '}
                            <span className="font-mono">
                                promote/{sourceBranch}-{chosen}
                            </span>
                            : the PR stays what was chosen. Opened with squash off.
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
        for (const flow of parseWorkspace(treeAt(state, state.branches[branchOf(state, env)])).flows) {
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
