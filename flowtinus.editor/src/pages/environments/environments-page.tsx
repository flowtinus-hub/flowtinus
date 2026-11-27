import { Link, Navigate } from 'react-router';
import { ArrowRight, GitBranch, Layers, TriangleAlert, Undo2 } from 'lucide-react';
import { workspaceSettingsPath } from '@/app/paths';
import { EmergencyRollbackBadge } from '@/components/emergency-rollback-badge';
import { ResourceView } from '@/components/resource-view';
import { useResource } from '@/data/use-resource';
import { shortSha } from '@/data/deployments/deployment';
import { useWorkspace } from '@/data/workspaces/use-workspace';
import { getEnvironments, getGitStatus, GIT_STATUS_CHANGED, type EnvironmentCard, type EnvironmentEdge, type Environments, type FlowCell, type FlowRow, type GitStatus, type PromotionState } from '@/data/git/git-api';
import { useLocalServer } from '@/lib/server-connection';
import { cn } from '@/lib/utils';
import { WorkspacePage } from '@/pages/workspaces/workspace-page';
import { ArchivedConnectionsPanel } from './archived-connections-panel';
import { GitStatusPanel } from './git-status-panel';
import { PromotePanel } from './promote-panel';

type On = Extract<Environments, { on: true }>;

const MODE_LABEL = { direct: 'Direct', 'pull-request': 'Pull requests', protected: 'Protected' } as const;

export function EnvironmentsPage() {
    const { handle } = useWorkspace();
    return useLocalServer() ? <Navigate to={`${workspaceSettingsPath(handle)}?tab=git#git`} replace /> : <EnvironmentsOfServer />;
}

function EnvironmentsOfServer() {
    const { handle, canEdit, isAdmin } = useWorkspace();
    const environments = useResource(`environments:${handle}`, () => getEnvironments(handle), { refreshOn: GIT_STATUS_CHANGED });
    const status = useResource(`git-status:${handle}`, () => getGitStatus(handle), { refreshOn: GIT_STATUS_CHANGED });
    const here = status.state.status === 'ready' ? status.state.value : null;
    // read again in place: a reload would show "Loading" and drop the panels' state
    const fresh = () => Promise.resolve({ ok: true as const, value: null });

    return (
        <WorkspacePage title="Environments">
            <ResourceView state={environments.state} onRetry={environments.reload} empty={{ icon: Layers, text: '' }} isEmpty={() => false}>
                {value =>
                    !value.on ? (
                        <p className="text-sm text-muted-foreground">
                            Git is off in this workspace.{' '}
                            <Link className="underline" to={`${workspaceSettingsPath(handle)}?tab=git`}>
                                Its settings
                            </Link>{' '}
                            turn it on.
                        </p>
                    ) : (
                        <div className="grid gap-8">
                            {value.problems.map(problem => (
                                <p key={problem} className="flex items-start gap-2 text-sm text-destructive">
                                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                                    {problem}
                                </p>
                            ))}
                            <Pipeline value={value} here={here} />
                            {here?.on && (
                                <section className="grid gap-3">
                                    <h2 className="text-lg font-semibold">This server ({value.environment})</h2>
                                    <GitStatusPanel
                                        handle={handle}
                                        status={here}
                                        readOnly={!canEdit}
                                        onChanged={async () => {
                                            await Promise.all([status.run(fresh()), environments.run(fresh())]);
                                        }}
                                    />
                                </section>
                            )}
                            <PromotePanel
                                handle={handle}
                                edges={value.edges.filter(e => e.source === value.environment)}
                                branchOf={env => value.pipeline.find(c => c.env === env)?.branch ?? env}
                                canPromote={isAdmin}
                                onOpened={() => void environments.run(fresh())}
                            />
                            <RunsWhere value={value} />
                            <ArchivedConnectionsPanel handle={handle} canDelete={isAdmin} />
                            <Activity value={value} />
                        </div>
                    )
                }
            </ResourceView>
        </WorkspacePage>
    );
}

function Pipeline({ value, here }: { value: On; here: GitStatus | null }) {
    if (value.pipeline.length === 0) {
        return null;
    }
    return (
        <section className="grid gap-3">
            <h2 className="text-lg font-semibold">Pipeline</h2>
            <div className="flex gap-3 overflow-x-auto pb-1">
                {value.pipeline.map(card => (
                    <EnvironmentCardView
                        key={card.env}
                        card={card}
                        into={value.edges.find(e => e.target === card.env) ?? null}
                        here={here}
                    />
                ))}
            </div>
        </section>
    );
}

function EnvironmentCardView({ card, into, here }: { card: EnvironmentCard; into: EnvironmentEdge | null; here: GitStatus | null }) {
    const status = card.here && here?.on ? here : null;
    return (
        <div
            className={cn(
                'grid w-72 shrink-0 content-start gap-2 rounded-lg border p-4 text-sm',
                card.here && 'border-primary/50 bg-primary/5',
            )}
        >
            <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium">{card.label}</span>
                {card.here && <span className="shrink-0 text-xs text-muted-foreground">this server</span>}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="font-mono">{card.env}</span>
                <span className="flex items-center gap-1 font-mono">
                    <GitBranch className="size-3.5" />
                    {card.branch}
                </span>
                <span>{MODE_LABEL[card.mode]}</span>
            </div>
            {card.warning && (
                <p className="flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                    <TriangleAlert className="mt-px size-3.5 shrink-0" />
                    {card.warning}
                </p>
            )}
            {!!card.emergencyRollbacks && (
                <p className="flex items-center gap-1 text-xs text-red-700 dark:text-red-400">
                    <Undo2 className="size-3.5 shrink-0" />
                    {card.emergencyRollbacks === 1 ? '1 flow' : `${card.emergencyRollbacks} flows`} in an emergency rollback
                </p>
            )}
            <div className="text-xs">
                <span className="text-muted-foreground">Tip </span>
                {card.tip ? (
                    <span className="font-mono">{shortSha(card.tip)}</span>
                ) : (
                    <span className="text-muted-foreground">no branch</span>
                )}
            </div>
            {status && (
                <div className="grid gap-1 text-xs">
                    <span>
                        <span className="text-muted-foreground">Deploy at </span>
                        {status.deploy ? (
                            <span className="font-mono">{shortSha(status.deploy.sha)}</span>
                        ) : (
                            <span className="text-muted-foreground">no commit yet</span>
                        )}
                    </span>
                    {status.refused && (
                        <span className="flex items-center gap-1 text-destructive">
                            <TriangleAlert className="size-3.5" /> Refused <span className="font-mono">{shortSha(status.refused.sha)}</span>
                        </span>
                    )}
                </div>
            )}
            {into && <EdgeLine edge={into} branch={card.branch} />}
        </div>
    );
}

function EdgeLine({ edge, branch }: { edge: EnvironmentEdge; branch: string }) {
    return (
        <div className="grid gap-1 border-t pt-2 text-xs">
            <span className="flex items-center gap-1 text-muted-foreground">
                From <span className="font-mono">{edge.source}</span> <ArrowRight className="size-3.5" />
            </span>
            {!edge.targetExists ? (
                <span className="text-muted-foreground">
                    The branch <span className="font-mono">{branch}</span> does not exist: turning git on in this environment creates it.
                </span>
            ) : edge.behind === null ? (
                <span className="text-muted-foreground">The source's branch does not exist.</span>
            ) : (
                <>
                    <span>
                        Behind: {edge.behind === 0 ? 'nothing to promote' : `${edge.behind} file${edge.behind === 1 ? '' : 's'} to promote`}
                    </span>
                    <span className={cn(edge.ahead && 'text-amber-700 dark:text-amber-400')}>
                        Ahead: {edge.ahead ? `yes, it has changes ${edge.source} lacks` : 'no'}
                        {edge.ahead && edge.backports.some(p => p.state === 'open') && ' · backport open'}
                        {edge.ahead && edge.backports.some(p => p.state === 'broken') && ' · backport broken'}
                    </span>
                    {edge.broken.length > 0 && <span className="text-destructive">Lineage broken: blocked until a repair is merged</span>}
                </>
            )}
        </div>
    );
}

const CELL_TEXT = (cell: FlowCell) =>
    cell.state === 'absent'
        ? 'Absent'
        : cell.state === 'undeployed'
          ? 'Undeployed'
          : cell.content === 'same'
            ? 'Same'
            : cell.content === 'other'
              ? 'Another version'
              : 'Deployed';

function RunsWhere({ value }: { value: On }) {
    const { environments, flows } = value.runsWhere;
    if (environments.length === 0) {
        return null;
    }
    const here = value.environment;
    return (
        <section className="grid gap-3">
            <div>
                <h2 className="text-lg font-semibold">What runs where</h2>
                <p className="text-sm text-muted-foreground">
                    Each environment as its branch says; {here} as this server runs it. Marked: what differs from {here}.
                </p>
            </div>
            {flows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No flows in any environment.</p>
            ) : (
                <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm">
                        <thead className="text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2 font-medium">Flow</th>
                                {environments.map(env => (
                                    <th key={env} className={cn('px-3 py-2 font-medium', env === here && 'bg-primary/5')}>
                                        <span className="font-mono">{env}</span>
                                        {env === here && <span className="ml-2">this server</span>}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {flows.map(flow => (
                                <FlowLine key={flow.id} flow={flow} environments={environments} here={here} />
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}

function FlowLine({ flow, environments, here }: { flow: FlowRow; environments: string[]; here: string }) {
    return (
        <tr className="border-t">
            <td className="px-3 py-2">{flow.name}</td>
            {environments.map(env => {
                const cell = flow.cells[env];
                return (
                    <td
                        key={env}
                        className={cn(
                            'px-3 py-2',
                            env === here && 'bg-primary/5',
                            cell?.differs && 'bg-amber-500/10 font-medium text-amber-800 dark:text-amber-300',
                            (!cell || cell.state === 'absent') && !cell?.differs && 'text-muted-foreground',
                        )}
                        title={cell?.differs ? `Differs from ${here}` : undefined}
                    >
                        {cell?.emergencyRollback ? (
                            <EmergencyRollbackBadge {...cell.emergencyRollback} />
                        ) : cell ? (
                            CELL_TEXT(cell)
                        ) : (
                            'No branch'
                        )}
                    </td>
                );
            })}
        </tr>
    );
}

const STATE_TEXT: Record<PromotionState, string> = { open: 'Open', broken: 'Lineage broken', merged: 'Merged', closed: 'Closed' };

function Activity({ value }: { value: On }) {
    const events = [
        ...value.promotions.map(p => ({
            key: `promotion:${p.id}`,
            at: p.openedAt,
            node: (
                <span className="grid gap-0.5">
                    <span className="flex flex-wrap items-center gap-x-2">
                        <span>
                            {p.kind === 'backport' ? 'Backport' : 'Promotion'} {p.source} <ArrowRight className="inline size-3.5" />{' '}
                            {p.target} of <span className="font-mono">{shortSha(p.sha)}</span>
                        </span>
                        <span
                            className={cn(
                                'rounded-full px-2 py-0.5 text-xs',
                                p.state === 'open'
                                    ? 'bg-primary/15'
                                    : p.state === 'merged'
                                      ? 'bg-emerald-500/15'
                                      : p.state === 'broken'
                                        ? 'bg-destructive/15 text-destructive'
                                        : 'bg-muted',
                            )}
                        >
                            {STATE_TEXT[p.state]}
                        </span>
                        {p.url && (
                            <a className="text-xs underline" href={p.url} target="_blank" rel="noreferrer">
                                Pull request
                            </a>
                        )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                        <span className="font-mono">{p.branch}</span>, by {p.openedBy ?? 'someone gone'}
                        {!p.inTopology && ': this edge is no longer in the topology'}
                    </span>
                </span>
            ),
        })),
        ...value.reconciles.map(r => ({
            key: `reconcile:${r.sha}:${r.at}`,
            at: r.at,
            node: (
                <span className={cn(r.outcome === 'refused' && 'text-destructive')}>
                    {r.outcome === 'applied' ? 'Applied' : 'Refused'} <span className="font-mono">{shortSha(r.sha)}</span>
                </span>
            ),
        })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    return (
        <section className="grid gap-3">
            <h2 className="text-lg font-semibold">Activity</h2>
            {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No promotion, backport or reconcile yet.</p>
            ) : (
                <ul className="max-h-96 divide-y overflow-y-auto rounded-lg border">
                    {events.map(event => (
                        <li key={event.key} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                            {event.node}
                            <span className="shrink-0 text-xs text-muted-foreground">{new Date(event.at).toLocaleString()}</span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
