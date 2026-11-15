import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Activity, Send, Server, Tag, TriangleAlert, User } from 'lucide-react';
import { ResourceView } from '@/components/resource-view';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorkers } from '@/data/workers/use-workers';
import { healthOf, summarizeTags, totals, type Supervisor, type TagSummary } from '@/data/workers/worker';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import { WorkerTagChip } from '@/components/worker-tag-chip';
import { WorkerIcon } from '@/components/worker-icon';

/**
 * The environment's workers (/workers, from flowtinus.server): per tag, what serves it and what waits; then each supervisor
 * (one per container) with its tags and its workers. Read only: a container's tags and workers come from its
 * WORKER_TAGS and WORKERS; a flow's tag says which of them run it.
 */
export function WorkersPage() {
    // live: its stream says what changes (a supervisor up or gone, a run taken or ended)
    const overview = useWorkers();
    // what is lost and the 'seen ... ago' move with the clock
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 15_000);
        return () => clearInterval(timer);
    }, []);

    return (
        <div className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col gap-8">
            <header className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-3">
                    <h1 className="text-3xl font-semibold tracking-tight">Workers</h1>
                    {overview.state.status === 'ready' && (
                        <span className="rounded-md border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                            {overview.state.value.environment}
                        </span>
                    )}
                </div>
                <p className="text-sm text-muted-foreground">Capacity and health of every supervisor attached to this environment.</p>
            </header>

            <ResourceView
                state={overview.state}
                onRetry={overview.reload}
                empty={{ icon: Server, text: 'No supervisor has started in this environment yet.' }}
                isEmpty={value => value.supervisors.length === 0 && Object.values(value.queuedByTag).every(n => n === 0)}
            >
                {value => {
                    const sum = totals(value.supervisors, now);
                    const tags = summarizeTags(value, now);
                    const online = value.supervisors.filter(s => healthOf(s, now) === 'online');
                    const servedTags = tags.filter(t => t.supervisors > 0).length;
                    return (
                        <>
                            <div className="grid gap-4 sm:grid-cols-3">
                                <Stat
                                    label="Supervisors"
                                    icon={User}
                                    value={sum.supervisors}
                                    footer={
                                        <>
                                            {sum.supervisors} online ·{' '}
                                            <span className={cn(sum.lost > 0 && 'text-destructive')}>{sum.lost} offline</span>
                                        </>
                                    }
                                />
                                <Stat
                                    label="Workers"
                                    icon={WorkerIcon}
                                    value={sum.workers}
                                    footer={`across ${servedTags} tag${servedTags === 1 ? '' : 's'}`}
                                />
                                <Stat
                                    label="Busy now"
                                    icon={Activity}
                                    value={
                                        <>
                                            {sum.busy}
                                            <span className="ml-1.5 text-xl font-normal text-muted-foreground">/ {sum.workers}</span>
                                        </>
                                    }
                                    footer={<BusyStrip supervisors={online} />}
                                />
                            </div>

                            <section className="flex flex-col gap-3">
                                <SectionTitle title="Tags" count={tags.length} />
                                <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                                    {tags.map(tag => (
                                        <TagRow key={tag.tag} tag={tag} />
                                    ))}
                                </ul>
                            </section>

                            <section className="flex flex-col gap-3">
                                <SectionTitle title="Supervisors" count={value.supervisors.length} />
                                <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                                    {value.supervisors.map(supervisor => (
                                        <SupervisorRow key={supervisor.id} supervisor={supervisor} tags={tags} now={now} />
                                    ))}
                                </ul>
                            </section>
                        </>
                    );
                }}
            </ResourceView>
        </div>
    );
}

function Stat({
    label,
    icon: Icon,
    value,
    footer,
}: {
    label: string;
    icon: ComponentType<{ className?: string }>;
    value: ReactNode;
    footer: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
            <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">{label}</p>
                <Icon className="size-4 text-muted-foreground/70" />
            </div>
            <p className="text-4xl leading-none font-semibold tabular-nums">{value}</p>
            <div className="min-h-5 font-mono text-xs text-muted-foreground">{footer}</div>
        </div>
    );
}

function SectionTitle({ title, count }: { title: string; count: number }) {
    return (
        <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold tracking-widest text-foreground/80 uppercase">{title}</h2>
            <span className="rounded-md bg-muted px-1.5 font-mono text-[10px] leading-4 text-muted-foreground">{count}</span>
        </div>
    );
}

/** past this many workers in all, the strip's cells would be too thin: one bar per supervisor instead */
const MAX_STRIP_CELLS = 60;

/**
 * The live supervisors' workers across the card's whole width: each supervisor a slice as wide as its share of the
 * workers, one cell per worker (the busy ones filled), however many supervisors and workers there are
 */
function BusyStrip({ supervisors }: { supervisors: Supervisor[] }) {
    const shown = supervisors.filter(s => s.workers > 0);
    const total = shown.reduce((n, s) => n + s.workers, 0);
    const cells = total <= MAX_STRIP_CELLS;

    return (
        <div className="flex h-5 w-full gap-2">
            {shown.map(s => {
                const full = s.busy >= s.workers;
                const fill = full ? 'bg-amber-500' : 'bg-sky-500';
                return (
                    <div
                        key={s.id}
                        className="flex min-w-0 gap-[3px]"
                        style={{ flex: `${s.workers} 1 0` }}
                        title={`${s.host}: ${s.busy} of ${s.workers} worker${s.workers === 1 ? '' : 's'} running a run`}
                    >
                        {cells ? (
                            Array.from({ length: s.workers }, (_, i) => (
                                <span
                                    key={i}
                                    className={cn('min-w-0 flex-1 rounded-[2px]', i < s.busy ? fill : 'bg-muted-foreground/20')}
                                />
                            ))
                        ) : (
                            <div className="h-full w-full overflow-hidden rounded-sm bg-muted-foreground/20">
                                <div className={cn('h-full', fill)} style={{ width: `${Math.min(1, s.busy / s.workers) * 100}%` }} />
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/** past this many workers a supervisor's cells would not fit in its row: one bar instead */
const MAX_CELLS = 24;

/** a supervisor's workers in its row, one cell each, the busy ones filled (amber when all are) */
function WorkerCells({ busy, workers }: { busy: number; workers: number }) {
    const full = workers > 0 && busy >= workers;
    const fill = full ? 'bg-amber-500' : 'bg-sky-500';
    const title = `${busy} of ${workers} worker${workers === 1 ? '' : 's'} running a run`;

    if (workers > MAX_CELLS) {
        return (
            <div title={title} className="h-4 w-28 overflow-hidden rounded-sm bg-muted-foreground/20">
                <div className={cn('h-full', fill)} style={{ width: `${Math.min(1, busy / workers) * 100}%` }} />
            </div>
        );
    }

    return (
        <div title={title} className="flex items-center gap-1">
            {Array.from({ length: workers }, (_, i) => (
                <span key={i} className={cn('h-4 w-2 rounded-[3px]', i < busy ? fill : 'bg-muted-foreground/20')} />
            ))}
        </div>
    );
}

/** busy workers out of all, as a long bar */
function LoadBar({ busy, workers }: { busy: number; workers: number }) {
    const share = workers === 0 ? 0 : Math.min(1, busy / workers);
    return (
        <div
            className="h-1.5 w-60 max-w-full overflow-hidden rounded-full bg-muted-foreground/15"
            title={`${busy} of ${workers} workers running a run`}
        >
            <div className={cn('h-full rounded-full', share >= 1 ? 'bg-amber-500' : 'bg-sky-500')} style={{ width: `${share * 100}%` }} />
        </div>
    );
}

function Count({ busy, workers }: { busy: number; workers: number }) {
    return (
        <span className="w-12 text-right font-mono text-xs tabular-nums text-muted-foreground">
            {busy}/{workers}
        </span>
    );
}

function TagRow({ tag }: { tag: TagSummary }) {
    return (
        <li className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3.5">
            <span className="flex w-52 min-w-0 items-center gap-2.5">
                <Tag className="size-4 shrink-0 text-muted-foreground/70" style={tag.color ? { color: tag.color } : undefined} />
                <span className="truncate font-mono text-sm">{tag.tag}</span>
            </span>
            <span className="text-sm text-muted-foreground">
                {tag.supervisors} supervisor{tag.supervisors === 1 ? '' : 's'}
            </span>
            <span className="flex-1" />
            {tag.unserved ? (
                <span className="flex items-center gap-1.5 text-sm text-destructive">
                    <TriangleAlert className="size-4" />
                    {tag.queued} queued, no supervisor takes this tag
                </span>
            ) : (
                <span className="flex items-center gap-6">
                    {tag.queued > 0 && <span className="text-sm text-muted-foreground">{tag.queued} queued</span>}
                    <LoadBar busy={tag.busy} workers={tag.workers} />
                    <Count busy={tag.busy} workers={tag.workers} />
                </span>
            )}
        </li>
    );
}

function SupervisorRow({ supervisor, tags, now }: { supervisor: Supervisor; tags: TagSummary[]; now: Date }) {
    const lost = healthOf(supervisor, now) === 'lost';
    // the tag's color as the other screens show it; a tag only lost supervisors have keeps this one's color
    const colorOf = (tag: string) => {
        const summary = tags.find(t => t.tag === tag && t.supervisors > 0);
        return summary ? summary.color : supervisor.color;
    };
    return (
        <li className={cn('flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4', lost && 'bg-destructive/5')}>
            <span
                className={cn(
                    'size-2.5 shrink-0 rounded-full ring-4',
                    lost ? 'bg-destructive ring-destructive/15' : 'bg-emerald-600 ring-emerald-500/15',
                )}
                aria-label={lost ? 'Not answering' : 'Online'}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
                    <span className="truncate font-mono text-sm font-medium">{supervisor.host}</span>
                    {/* its id (runs.worker_id, the logs' supervisorId): what to search for in the logs */}
                    <span className="truncate font-mono text-xs text-muted-foreground select-all">{supervisor.id}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                        {supervisor.tags.map(tag => (
                            <WorkerTagChip key={tag} tag={tag} color={colorOf(tag)} className="rounded-full bg-muted px-2.5" />
                        ))}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <WorkerIcon className="size-3.5" /> {supervisor.workers} worker{supervisor.workers === 1 ? '' : 's'}
                    </span>
                    {supervisor.fireAndForgetPerWorker !== null && (
                        <span
                            className="flex items-center gap-1.5 text-xs text-muted-foreground"
                            title={`A Flow Invoker fires and forgets at most ${supervisor.fireAndForgetPerWorker} runs per worker in a run (FIRE_AND_FORGET_PER_WORKER)`}
                        >
                            <Send className="size-3.5" /> fire and forget {supervisor.fireAndForgetPerWorker} × {supervisor.workers} ={' '}
                            {supervisor.fireAndForgetPerWorker * supervisor.workers} per run
                        </span>
                    )}
                </div>
            </div>
            {lost ? (
                <span className="text-sm text-destructive">Not answering</span>
            ) : (
                <span className="flex items-center gap-6">
                    <WorkerCells busy={supervisor.busy} workers={supervisor.workers} />
                    <Count busy={supervisor.busy} workers={supervisor.workers} />
                </span>
            )}
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="w-24 text-right text-sm text-muted-foreground">Seen {relativeTime(supervisor.lastSeen, now)}</span>
                </TooltipTrigger>
                <TooltipContent>
                    Up since {formatDateTime(supervisor.startedAt)}
                    {supervisor.version ? `, version ${supervisor.version}` : ''}
                </TooltipContent>
            </Tooltip>
        </li>
    );
}
