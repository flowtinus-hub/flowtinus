import { descendants, isOpen, isProblem, shortId, statusCounts, type RunNode } from '@/data/runs/run-history';
import { formatDateTime, formatTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import { VersionChip } from '@/components/version-chip';
import { duration, envelopes, StatusPill, TRIGGER_LABEL } from './run-status';

/** the color of a run in a segmented bar or the timeline */
export const BAR: Record<RunNode['status'], string> = {
    queued: 'bg-muted-foreground/25',
    running: 'bg-sky-500',
    completed: 'bg-emerald-500',
    'with-warnings': 'bg-amber-500',
    'with-errors': 'bg-red-500',
    failed: 'bg-red-500',
    cancelled: 'bg-muted-foreground/40',
    skipped: 'bg-amber-500/40',
};

/** past this many runs in a tree, its bar has one segment per status (as wide as its count) instead of one per run */
const SEGMENTS = 40;

/** the table's columns, the header's and every row's: status, flow, project, trigger, started, duration, envelopes, fan-out, worker */
const COLUMNS =
    'grid grid-cols-[7.5rem_minmax(11rem,2fr)_minmax(8rem,1.2fr)_minmax(8rem,1fr)_minmax(7rem,0.8fr)_5rem_7rem_minmax(9rem,1.5fr)_minmax(5rem,0.8fr)] gap-x-3';

type Props = {
    roots: RunNode[];
    /** per top run: how many runs its tree has in all (the page may bring fewer) */
    treeSizes: Record<string, number>;
    /** there are older top runs: a button asks for them */
    hasMore: boolean;
    onMore: () => void;
    /** the top run open in the drawer */
    selected?: string;
    onSelect: (id: string) => void;
    now: Date;
};

/**
 * The top runs, newest first, as a table the width of the page: how each went, its flow, project, trigger, when it
 * started and for how long, its envelopes, a bar with one segment per run it queued in its color (still going, failed
 * below) and the worker that ran it; its error under the row when it failed. A click opens it in the drawer. Narrower
 * than the table, it scrolls sideways.
 */
export function RunList({ roots, treeSizes, hasMore, onMore, selected, onSelect, now }: Props) {
    return (
        <div className="flex min-w-0 flex-col">
            {/* contain-inline-size: the table's width does not widen the page (it scrolls here instead) */}
            <div className="overflow-x-auto contain-inline-size">
                {/* at least the columns' minimums (COLUMNS) with their gaps and the row's padding */}
                <div role="table" aria-label="Runs" className="min-w-[76rem]">
                    <div role="row" className={cn(COLUMNS, 'border-b px-4 py-2 text-xs text-muted-foreground')}>
                        <span role="columnheader">Status</span>
                        <span role="columnheader">Flow</span>
                        <span role="columnheader">Project</span>
                        <span role="columnheader">Trigger</span>
                        <span role="columnheader">Started</span>
                        <span role="columnheader" className="text-right">
                            Duration
                        </span>
                        <span role="columnheader" className="text-right">
                            Envelopes
                        </span>
                        <span role="columnheader" title="The runs it queued (fire and forget), one segment each">
                            Fan-out
                        </span>
                        <span role="columnheader">Worker</span>
                    </div>
                    <div role="rowgroup" className="divide-y">
                        {roots.map(root => (
                            <RunRow
                                key={root.id}
                                run={root}
                                treeSize={treeSizes[root.id] ?? 0}
                                selected={selected === root.id}
                                onSelect={onSelect}
                                now={now}
                            />
                        ))}
                    </div>
                </div>
            </div>
            <div className="flex items-center justify-center gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
                <span>
                    Showing {roots.length} root run{roots.length === 1 ? '' : 's'}
                    {hasMore ? '' : ' (all)'} · the runs they queued are inside each one
                </span>
                {hasMore && (
                    <button type="button" onClick={onMore} className="rounded-md border px-2 py-1 text-foreground hover:bg-accent">
                        Load more
                    </button>
                )}
            </div>
        </div>
    );
}

function RunRow({
    run,
    treeSize,
    selected,
    onSelect,
    now,
}: {
    run: RunNode;
    treeSize: number;
    selected: boolean;
    onSelect: (id: string) => void;
    now: Date;
}) {
    const below = descendants(run);
    const total = Math.max(treeSize, below.length);
    const problems = below.filter(r => isProblem(r.status)).length;
    const going = below.filter(r => isOpen(r.status)).length;
    const started = run.startedAt ?? run.queuedAt;
    const took = run.durationMs ?? (run.startedAt ? now.getTime() - run.startedAt.getTime() : undefined);
    const muted = run.status === 'cancelled' || run.status === 'skipped';
    return (
        // data-run-row: a click on it while the drawer is open shows this run there instead of closing it
        <button
            type="button"
            role="row"
            data-run-row
            aria-current={selected || undefined}
            onClick={() => onSelect(run.id)}
            className={cn(
                'block w-full border-l-2 px-4 py-2.5 text-left text-sm transition-colors hover:bg-accent/50',
                selected ? 'border-l-primary bg-accent/40' : 'border-l-transparent',
            )}
        >
            <span className={cn(COLUMNS, 'items-center')}>
                <span role="cell">
                    <StatusPill status={run.status} />
                </span>
                <span role="cell" className="min-w-0">
                    <span className={cn('flex min-w-0 items-baseline gap-1.5 font-medium', muted && 'text-muted-foreground')}>
                        <span className="truncate">{run.flowName}</span>
                        <VersionChip version={run.version} />
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                        {shortId(run.id)}
                        {run.rerunOf ? ` · re-run of ${shortId(run.rerunOf)}` : ''}
                    </span>
                </span>
                <span role="cell" className="min-w-0">
                    <span className="block truncate">{run.projectName}</span>
                    <span className="block truncate text-xs text-muted-foreground">{run.workspaceName}</span>
                </span>
                <span role="cell" className="min-w-0">
                    <span className="block truncate">{TRIGGER_LABEL[run.trigger]}</span>
                    <span className="block truncate text-xs text-muted-foreground">{run.startedBy ?? '—'}</span>
                </span>
                <span role="cell" className="min-w-0" title={formatDateTime(started)}>
                    <span className="block truncate">
                        {run.status === 'queued' ? `waiting, ${relativeTime(run.queuedAt, now)}` : relativeTime(started, now)}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{formatTime(started)}</span>
                </span>
                <span role="cell" className="text-right font-mono text-xs">
                    {took === undefined ? '—' : duration(took)}
                </span>
                <span role="cell" className="text-right font-mono text-xs">
                    {envelopes(run)}
                </span>
                <span role="cell" className="min-w-0">
                    {below.length > 0 ? (
                        <span className="flex flex-col gap-1">
                            <span className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-label={`${total} queued run(s)`}>
                                {below.length <= SEGMENTS
                                    ? below.map(child => (
                                          <span
                                              key={child.id}
                                              className={cn(
                                                  'h-full flex-1',
                                                  BAR[child.status],
                                                  child.status === 'running' && 'animate-pulse',
                                              )}
                                              title={`${child.flowName} · ${child.status}`}
                                          />
                                      ))
                                    : statusCounts(below).map(({ status, count }) => (
                                          <span
                                              key={status}
                                              className={cn('h-full', BAR[status])}
                                              style={{ flexGrow: count }}
                                              title={`${count} ${status}`}
                                          />
                                      ))}
                            </span>
                            <span className={cn('truncate text-xs', problems > 0 ? 'text-destructive' : 'text-muted-foreground')}>
                                {total} run{total === 1 ? '' : 's'}
                                {going > 0 ? ` · ${going} going` : ''}
                                {problems > 0 ? ` · ${problems} failed` : ''}
                            </span>
                        </span>
                    ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                    )}
                </span>
                <span role="cell" className="truncate font-mono text-xs text-muted-foreground" title={run.workerId}>
                    {run.workerId ?? '—'}
                </span>
            </span>

            {run.error && isProblem(run.status) && (
                <span className="mt-2 ml-[8.25rem] block truncate rounded-md bg-destructive/10 px-2 py-1 font-mono text-xs text-destructive">
                    {run.error}
                </span>
            )}
        </button>
    );
}
