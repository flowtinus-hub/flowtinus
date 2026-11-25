import type { GraphCommit } from '@/data/git/git-api';
import { cn } from '@/lib/utils';

const LANE = 16;
const ROW = 48;
const GOES = 'var(--color-primary)';
const STAYS = 'var(--color-muted-foreground)';

type Row = { commit: GraphCommit; col: number; before: (string | null)[]; after: (string | null)[] };

/** each commit's lane, with the lanes passing above and below it: children come before their parents */
function layout(commits: GraphCommit[]): Row[] {
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

/** what promoting `chosen` carries, among the commits shown */
function carried(commits: GraphCommit[], chosen: string | null): Set<string> {
    const bySha = new Map(commits.map(c => [c.sha, c]));
    const goes = new Set<string>();
    const stack = chosen ? [chosen] : [];
    while (stack.length) {
        const sha = stack.pop()!;
        const commit = bySha.get(sha);
        if (!commit || goes.has(sha) || commit.inTarget) {
            continue;
        }
        goes.add(sha);
        stack.push(...commit.parents);
    }
    return goes;
}

const x = (lane: number) => lane * LANE + LANE / 2;
const curve = (x1: number, y1: number, x2: number, y2: number) =>
    x1 === x2 ? `M ${x1} ${y1} L ${x2} ${y2}` : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;

export function CommitGraph({
    commits,
    branch,
    chosen,
    onChoose,
}: {
    commits: GraphCommit[];
    branch: string;
    chosen: string | null;
    onChoose: (sha: string) => void;
}) {
    const rows = layout(commits);
    const goes = carried(commits, chosen);
    const width = Math.max(1, ...rows.map(r => Math.max(r.before.length, r.after.length, r.col + 1))) * LANE;
    const stroke = (sha: string | null) => (sha && goes.has(sha) ? GOES : STAYS);

    return (
        <ul>
            {rows.map(({ commit, col, before, after }) => {
                const picked = chosen === commit.sha;
                const going = goes.has(commit.sha);
                const dot = going ? GOES : STAYS;
                return (
                    <li key={commit.sha}>
                        <button
                            type="button"
                            disabled={!commit.choosable}
                            aria-pressed={picked}
                            title={
                                commit.inTarget
                                    ? 'Already in the target'
                                    : commit.choosable
                                      ? `Promote up to ${commit.sha.slice(0, 12)}`
                                      : `${branch} was never at this commit: it came in through a merge and goes with that merge.`
                            }
                            className={cn(
                                'flex w-full items-center gap-3 px-4 text-left disabled:cursor-default',
                                commit.choosable && 'hover:bg-muted/50',
                                picked && 'bg-primary/10 hover:bg-primary/15',
                            )}
                            style={{ height: ROW }}
                            onClick={() => onChoose(commit.sha)}
                        >
                            <svg width={width} height={ROW} className="shrink-0" aria-hidden>
                                {before.map((sha, lane) =>
                                    sha === null ? null : (
                                        <path
                                            key={`in-${lane}`}
                                            d={sha === commit.sha ? curve(x(lane), 0, x(col), ROW / 2) : curve(x(lane), 0, x(lane), ROW)}
                                            stroke={stroke(sha)}
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
                                            stroke={stroke(parent)}
                                            strokeWidth={2}
                                            fill="none"
                                        />
                                    );
                                })}
                                <circle
                                    cx={x(col)}
                                    cy={ROW / 2}
                                    r={commit.choosable ? 5 : 3.5}
                                    fill={commit.parents.length > 1 ? 'var(--color-card)' : dot}
                                    stroke={dot}
                                    strokeWidth={2}
                                />
                            </svg>
                            <span className={cn('grid min-w-0 flex-1 gap-0.5', !going && 'opacity-50')}>
                                <span className="flex min-w-0 items-center gap-2">
                                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                                        {commit.sha.slice(0, 7)}
                                    </span>
                                    <span className="truncate text-sm">{commit.message}</span>
                                </span>
                                <span className="truncate text-xs text-muted-foreground">
                                    {commit.author}, {new Date(commit.at).toLocaleString()}
                                    {commit.inTarget && ', already in the target'}
                                </span>
                            </span>
                            {picked && <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-xs">up to here</span>}
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
