import { cn } from '@/lib/utils';
import { ancestors, type Commit, type CommitKind, type State } from './model';
import { Pill, when } from './ui';

const LANE = 18;
const ROW = 58;
const COLORS = ['#f59e0b', '#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#fb7185'];
const STAYS = '#6b7280';

const KIND: Partial<Record<CommitKind, string>> = {
    outside: 'direct push',
    merge: 'merge',
    promotion: 'promotion',
    backport: 'backport',
    hotfix: 'hotfix',
    repair: 'repair',
    update: 'update',
};

type Row = { commit: Commit; col: number; before: (string | null)[]; after: (string | null)[] };

function layout(commits: Commit[]): Row[] {
    let lanes: (string | null)[] = [];
    return commits.map(commit => {
        const before = [...lanes];
        let col = lanes.indexOf(commit.sha);
        if (col === -1) {
            col = lanes.indexOf(null);
            if (col === -1) {
                col = lanes.length;
            }
        }
        lanes = lanes.map(l => (l === commit.sha ? null : l));
        lanes[col] = null;
        commit.parents.forEach((parent, i) => {
            if (lanes.includes(parent)) {
                return;
            }
            if (i === 0) {
                lanes[col] = parent;
                return;
            }
            const free = lanes.indexOf(null);
            lanes[free === -1 ? lanes.length : free] = parent;
        });
        while (lanes.length && lanes[lanes.length - 1] === null) {
            lanes.pop();
        }
        return { commit, col, before, after: [...lanes] };
    });
}

const x = (lane: number) => lane * LANE + LANE / 2;
const curve = (x1: number, y1: number, x2: number, y2: number) =>
    x1 === x2 ? `M ${x1} ${y1} L ${x2} ${y2}` : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;

export function CommitGraph({
    state,
    commits,
    tip,
    chosen,
    branch,
    onChoose,
}: {
    state: State;
    commits: Commit[];
    tip: string;
    chosen: string;
    branch: string;
    onChoose: (sha: string) => void;
}) {
    const ordered = [...commits].sort((a, b) => b.at - a.at);
    const rows = layout(ordered);
    const pending = new Set(ordered.map(c => c.sha));
    const mainline = new Set<string>();
    for (let sha: string | undefined = tip; sha && pending.has(sha); sha = state.commits[sha]?.parents[0]) {
        mainline.add(sha);
    }
    const included = ancestors(state, chosen);
    const width = Math.max(1, ...rows.map(r => Math.max(r.before.length, r.after.length, r.col + 1))) * LANE;
    const stroke = (lane: number, sha: string | null) => (sha && included.has(sha) ? COLORS[lane % COLORS.length] : STAYS);

    return (
        <ul>
            {rows.map(({ commit, col, before, after }) => {
                const selectable = mainline.has(commit.sha);
                const goes = included.has(commit.sha);
                const picked = chosen === commit.sha;
                const dot = goes ? COLORS[col % COLORS.length] : STAYS;
                return (
                    <li key={commit.sha}>
                        <button
                            type="button"
                            aria-disabled={!selectable}
                            aria-pressed={picked}
                            title={
                                selectable
                                    ? `Promote up to ${commit.sha}`
                                    : `${branch} was never at this commit: it came in through a merge and goes with the merge that brought it.`
                            }
                            className={cn(
                                'flex w-full items-center gap-3 px-4 text-left',
                                selectable ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default',
                                picked && 'bg-amber-500/10 hover:bg-amber-500/15',
                            )}
                            style={{ height: ROW }}
                            onClick={() => selectable && onChoose(commit.sha)}
                        >
                            <svg width={width} height={ROW} className="shrink-0" aria-hidden>
                                {before.map((sha, lane) =>
                                    sha === null ? null : sha === commit.sha ? (
                                        <path
                                            key={`in-${lane}`}
                                            d={curve(x(lane), 0, x(col), ROW / 2)}
                                            stroke={stroke(lane, sha)}
                                            strokeWidth={2}
                                            fill="none"
                                        />
                                    ) : (
                                        <path
                                            key={`through-${lane}`}
                                            d={curve(x(lane), 0, x(lane), ROW)}
                                            stroke={stroke(lane, sha)}
                                            strokeWidth={2}
                                            fill="none"
                                        />
                                    ),
                                )}
                                {commit.parents.map(parent => {
                                    const lane = after.indexOf(parent);
                                    return lane === -1 ? null : (
                                        <path
                                            key={`out-${parent}`}
                                            d={curve(x(col), ROW / 2, x(lane), ROW)}
                                            stroke={goes ? COLORS[lane % COLORS.length] : STAYS}
                                            strokeWidth={2}
                                            fill="none"
                                        />
                                    );
                                })}
                                <circle
                                    cx={x(col)}
                                    cy={ROW / 2}
                                    r={5}
                                    fill={commit.parents.length > 1 ? 'var(--card)' : dot}
                                    stroke={dot}
                                    strokeWidth={2}
                                />
                            </svg>
                            <span className={cn('grid min-w-0 flex-1 gap-0.5', !goes && 'opacity-40')}>
                                <span className="flex min-w-0 items-center gap-2">
                                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{commit.sha}</span>
                                    <span className="truncate text-sm">{commit.message}</span>
                                </span>
                                <span className="truncate text-xs text-muted-foreground">
                                    {commit.author}, {when(commit.at)} {commit.sha === tip && '(tip)'}
                                </span>
                            </span>
                            {KIND[commit.kind] && <Pill className={cn(!goes && 'opacity-40')}>{KIND[commit.kind]}</Pill>}
                            {picked && <Pill tone="warn">up to here</Pill>}
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
