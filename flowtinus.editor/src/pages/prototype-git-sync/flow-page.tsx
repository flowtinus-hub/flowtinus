import { useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, MarkerType, Panel, Position, ReactFlow, type Edge, type Node as RfNode } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CalendarClock, ChevronRight, CircleOff, History, Lock, Pencil, Plus, Rocket, SlidersHorizontal, Tag, TriangleAlert } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ThemeToggle } from '@/layout/theme-toggle';
import { cn } from '@/lib/utils';
import { changeFlow, currentBranch, deployNoGit, editRefusal, envBranch, pinFlow, renameFlow, server, setScheduleEnabled, setScheduleOverride, unpinFlow, workingTree } from './actions';
import { BranchPicker } from './branch-picker';
import { isDeployed, modeOf, parseWorkspace, shortHash, versionHash, type FlowItem, type ScheduleDefaults } from './model';
import { ChangesButton, EnvPill } from './shell';
import { useStore } from './store';
import { BASE, NameDialog, Pill, projectRoute, Sha, when } from './ui';

export function FlowPage() {
    const { state, act } = useStore();
    const { flowId = '' } = useParams();
    const [renaming, setRenaming] = useState(false);
    const s = server(state);
    const tree = workingTree(state);
    const flow = parseWorkspace(tree).flows.find(f => f.id === flowId);
    const refusal = s.gitOn ? editRefusal(state) : null;
    const branch = currentBranch(state);

    return (
        <div className="flex h-svh flex-col">
            <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
                <nav className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                    <Link to={BASE} className="text-muted-foreground hover:text-foreground">
                        Acme
                    </Link>
                    {flow && (
                        <>
                            <ChevronRight className="size-4 text-muted-foreground" />
                            <Link to={projectRoute(flow.project)} className="text-muted-foreground hover:text-foreground">
                                {flow.project}
                            </Link>
                            {flow.folder
                                .split('/')
                                .filter(Boolean)
                                .map(part => (
                                    <span key={part} className="flex items-center gap-2 text-muted-foreground">
                                        <ChevronRight className="size-4" /> {part}
                                    </span>
                                ))}
                            <ChevronRight className="size-4 text-muted-foreground" />
                            <span className="truncate font-medium">{flow.name}</span>
                            <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label="Rename the flow"
                                disabled={!!refusal}
                                onClick={() => setRenaming(true)}
                            >
                                <Pencil />
                            </Button>
                        </>
                    )}
                </nav>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                    <ChangesButton drawer />
                    <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                    <EnvPill />
                    <ThemeToggle />
                </div>
            </header>
            <main className="relative min-h-0 flex-1">
                {!flow ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                        <p>
                            This flow is not on <span className="font-mono">{branch === '__postgres__' ? 'this server' : branch}</span>.
                        </p>
                        <div className="flex gap-2">
                            <BranchPicker />
                            <Button variant="outline" size="sm" asChild>
                                <Link to={BASE}>Projects</Link>
                            </Button>
                        </div>
                    </div>
                ) : (
                    <Canvas flow={flow} refusal={refusal} />
                )}
            </main>
            {flow && (
                <NameDialog
                    open={renaming}
                    title={`Rename ${flow.name}`}
                    description="The flow's file is its name: a rename moves the file in git."
                    label="Name"
                    initial={flow.name}
                    confirm="Rename"
                    onClose={() => setRenaming(false)}
                    onSubmit={v => act(d => renameFlow(d, flow.id, v))}
                />
            )}
        </div>
    );
}

function Canvas({ flow, refusal }: { flow: FlowItem; refusal: string | null }) {
    const { state, act } = useStore();
    const s = server(state);
    const nodes: RfNode[] = useMemo(
        () =>
            flow.doc.nodes.map(n => {
                const connection = typeof n.config?.connection === 'string' ? s.connections[n.config.connection] : undefined;
                const missing = typeof n.config?.connection === 'string' && (!connection || !connection.configured);
                return {
                    id: n.id,
                    position: { x: n.position.x, y: n.position.y + 120 },
                    sourcePosition: Position.Right,
                    targetPosition: Position.Left,
                    data: {
                        label: (
                            <div className="grid gap-0.5 text-left">
                                <span className="text-[10px] text-muted-foreground uppercase">{n.type}</span>
                                <span className="text-sm font-medium">{n.label ?? n.id}</span>
                                {n.config &&
                                    Object.entries(n.config).map(([k, v]) => (
                                        <span key={k} className="font-mono text-[10px] text-muted-foreground">
                                            {k}: {String(v)}
                                        </span>
                                    ))}
                                {missing && (
                                    <span className="flex items-center gap-1 text-[10px] text-amber-600">
                                        <TriangleAlert className="size-3" /> connection not configured in {s.env}
                                    </span>
                                )}
                            </div>
                        ),
                    },
                    style: {
                        width: 200,
                        borderRadius: 10,
                        background: 'var(--card)',
                        color: 'var(--card-foreground)',
                        borderColor: missing ? '#d97706' : 'var(--border)',
                    },
                };
            }),
        [flow, s.connections, s.env],
    );
    const edges: Edge[] = flow.doc.edges.map(e => {
        const [source, target] = e.split(' -> ');
        return { id: e, source: source!, target: target!, markerEnd: { type: MarkerType.ArrowClosed } };
    });
    const editable = flow.doc.nodes.find(n => n.config && Object.values(n.config).some(v => typeof v === 'number'));

    return (
        <div className={cn('h-full w-full', refusal && '[&_.react-flow__node]:opacity-80')}>
            <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} proOptions={{ hideAttribution: true }}>
                <Background variant={BackgroundVariant.Dots} gap={16} size={1.5} color="var(--grid)" />
                <Controls showInteractive={false} />
                <Panel position="top-left" className="flex w-[calc(100%-24px)] flex-wrap items-start gap-2">
                    <div className="flex flex-wrap gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="bg-card shadow-md"
                            disabled={!editable}
                            title="Prototype: stands for any edit on the canvas"
                            onClick={() =>
                                act(d =>
                                    changeFlow(
                                        d,
                                        flow.id,
                                        doc => {
                                            const node = doc.nodes.find(n => n.id === editable!.id)!;
                                            const [key, value] = Object.entries(node.config!).find(([, v]) => typeof v === 'number')!;
                                            const n = value as number;
                                            node.config![key] = n >= 1 ? n + 1 : Math.round((n + 0.01) * 100) / 100;
                                        },
                                        'a setting changed',
                                    ),
                                )
                            }
                        >
                            <SlidersHorizontal /> Change a setting
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="bg-card shadow-md"
                            onClick={() =>
                                act(d =>
                                    changeFlow(
                                        d,
                                        flow.id,
                                        doc => {
                                            const end = doc.nodes.find(n => n.type === 'End')!;
                                            const id = `log${doc.nodes.length}`;
                                            const before = doc.edges.find(e => e.endsWith(`-> ${end.id}`))!;
                                            const source = before.split(' -> ')[0]!;
                                            doc.nodes.push({
                                                id,
                                                type: 'Log',
                                                label: 'Log',
                                                position: { x: end.position.x, y: end.position.y },
                                                config: { level: 'info' },
                                            });
                                            end.position = { x: end.position.x + 260, y: end.position.y };
                                            doc.edges = [
                                                ...doc.edges.filter(e => e !== before),
                                                `${source} -> ${id}`,
                                                `${id} -> ${end.id}`,
                                            ];
                                        },
                                        'a component added',
                                    ),
                                )
                            }
                        >
                            <Plus /> Add a component
                        </Button>
                    </div>
                    <div className="ml-auto flex flex-wrap justify-end gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="bg-card font-mono shadow-md"
                            title="The worker tag (unchanged by git sync)"
                        >
                            <Tag /> {flow.doc.workerTag}
                        </Button>
                        {s.gitOn ? <GitVersions flow={flow} refusal={refusal} /> : <DeployNoGit flow={flow} />}
                        <Schedules flow={flow} refusal={refusal} />
                    </div>
                </Panel>
                {refusal && (
                    <Panel position="bottom-center" className="mb-16">
                        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow-md dark:bg-amber-950 dark:text-amber-200">
                            <Lock className="size-4" /> {refusal}
                        </div>
                    </Panel>
                )}
            </ReactFlow>
        </div>
    );
}

function GitVersions({ flow, refusal }: { flow: FlowItem; refusal: string | null }) {
    const { state, act } = useStore();
    const s = server(state);
    const row = s.flows[flow.id];
    const workingHash = versionHash(workingTree(state)[flow.path]!);
    const running = row?.current ? row.versions.find(v => v.n === row.current) : undefined;
    const differs = row?.versions.at(-1) && row.versions.at(-1)!.hash !== workingHash;
    const pinned = s.pins[flow.id];
    const protectedEnv = modeOf(state, s.env) === 'protected';
    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="bg-card shadow-md">
                        <History /> Versions
                        {!row ? (
                            <Pill className="text-[10px]">not in {s.env}</Pill>
                        ) : row.current === null ? (
                            <Pill tone="warn" className="text-[10px]">
                                not running
                            </Pill>
                        ) : (
                            <Pill tone={differs || pinned !== undefined ? 'warn' : 'ok'} className="font-mono text-[10px]">
                                v{row.current}
                                {pinned !== undefined ? ' · pinned' : differs && ' · branch differs'}
                            </Pill>
                        )}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[28rem]">
                    <DropdownMenuLabel className="font-normal text-muted-foreground">
                        {s.env}: versions come from merges into <span className="font-mono">{envBranch(state)}</span> (no Deploy button with
                        git)
                    </DropdownMenuLabel>
                    {!row && (
                        <p className="px-2 py-1 text-sm text-muted-foreground">
                            Not in {s.env} yet: it arrives when its file reaches {envBranch(state)}.
                        </p>
                    )}
                    {row?.current === null && (
                        <p className="px-2 py-1 text-sm text-amber-700">
                            Not running: the file on {envBranch(state)} says deployed: false (or the file is gone).
                        </p>
                    )}
                    {pinned !== undefined && (
                        <div className="grid gap-1 px-2 py-1 text-sm text-amber-700">
                            <span>
                                Pinned to v{pinned} in an emergency: {s.env} differs from git until a commit changes this flow. The fix is a
                                hotfix.
                            </span>
                            <Button
                                size="xs"
                                variant="outline"
                                className="justify-self-start"
                                onClick={() => act(d => unpinFlow(d, flow.id))}
                            >
                                Remove the pin
                            </Button>
                        </div>
                    )}
                    {row?.versions
                        .slice()
                        .reverse()
                        .map(v => (
                            <DropdownMenuItem
                                key={v.n}
                                className="items-start"
                                disabled={v.n === row.current}
                                title={v.n === row.current ? undefined : `Emergency pin: run v${v.n} in ${s.env} without git`}
                                onSelect={() => act(d => pinFlow(d, flow.id, v.n))}
                            >
                                <span className="w-8 font-mono text-xs">v{v.n}</span>
                                <span className="grid flex-1 gap-0.5">
                                    <span className="text-xs">{v.message}</span>
                                    <span className="flex gap-2 text-[10px] text-muted-foreground">
                                        <Sha sha={v.sha} /> {when(v.at)} {!v.deployedField && '· deployed: false'}
                                    </span>
                                </span>
                                {v.n === row.current && (
                                    <Pill tone="ok" className="text-[10px]">
                                        <Rocket className="size-3" /> running
                                    </Pill>
                                )}
                            </DropdownMenuItem>
                        ))}
                    <DropdownMenuSeparator />
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                        Click an older version to pin it here in an emergency (versions are this server's: v2 here can be v3 elsewhere; the
                        sha is what environments share).{' '}
                        {protectedEnv ? 'The fix itself goes through a hotfix branch.' : 'The fix itself is a commit.'}
                    </p>
                    {running && differs && (
                        <p className="px-2 py-1 text-xs text-muted-foreground">
                            Your branch's file differs from v{running.n}: merge it to {envBranch(state)} to deploy it.
                        </p>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <label
                className="flex h-7 items-center gap-2 rounded-md border bg-card px-2 text-xs shadow-md"
                title="Absent in the file means deployed. Turning it off writes deployed: false (an undeploy is a commit, promoted like any other); it makes no new version."
            >
                {isDeployed(flow.doc) ? <Rocket className="size-3.5" /> : <CircleOff className="size-3.5" />}
                deployed
                <Switch
                    checked={isDeployed(flow.doc)}
                    disabled={!!refusal}
                    onCheckedChange={v =>
                        act(d =>
                            changeFlow(
                                d,
                                flow.id,
                                doc => {
                                    if (v) {
                                        delete doc.deployed;
                                    } else {
                                        doc.deployed = false;
                                    }
                                },
                                v ? 'deployed (the field removed)' : 'deployed: false',
                            ),
                        )
                    }
                />
            </label>
        </>
    );
}

function DeployNoGit({ flow }: { flow: FlowItem }) {
    const { state, act } = useStore();
    const s = server(state);
    const row = s.flows[flow.id];
    return (
        <Button size="sm" className="shadow-md" onClick={() => act(d => deployNoGit(d, flow.id))}>
            <Rocket /> Deploy
            <span className="rounded-full bg-primary-foreground/20 px-1.5 text-[10px]">
                {row?.current ? `v${row.current}` : 'Not deployed'}
            </span>
        </Button>
    );
}

function Schedules({ flow, refusal }: { flow: FlowItem; refusal: string | null }) {
    const { state, act } = useStore();
    const [open, setOpen] = useState(false);
    const s = server(state);
    const schedules = flow.doc.schedules ?? [];
    const rows = schedules.map(sc => s.schedules[sc.id]);
    const enabled = rows.filter(r => r?.enabled).length;
    return (
        <>
            <Button variant="outline" size="sm" className="bg-card shadow-md" onClick={() => setOpen(true)}>
                <CalendarClock /> Schedules
                <span className="text-[10px] text-muted-foreground">
                    {enabled}/{schedules.length}
                </span>
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-3xl">
                    <DialogHeader>
                        <DialogTitle>Schedules of {flow.name}</DialogTitle>
                        <DialogDescription>
                            Git holds the schedule and its defaults (promoted with the flow). {s.env} holds an override of any of them and
                            whether it is enabled: those never go to git.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid max-h-[60vh] gap-4 overflow-auto">
                        {schedules.length === 0 && <p className="text-sm text-muted-foreground">No schedule.</p>}
                        {schedules.map(sc => {
                            const row = s.schedules[sc.id];
                            return (
                                <div key={sc.id} className="grid gap-2 rounded-lg border p-3">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium">{sc.name}</span>
                                        <Sha sha={sc.id} />
                                        {s.gitOn && !row && (
                                            <Pill>not in {s.env} yet: arrives disabled, here too; enable it after the merge</Pill>
                                        )}
                                        {row && (
                                            <label className="ml-auto flex items-center gap-2 text-sm">
                                                Enabled in {s.env}
                                                <Switch
                                                    checked={row.enabled}
                                                    onCheckedChange={v => act(d => setScheduleEnabled(d, sc.id, v))}
                                                />
                                            </label>
                                        )}
                                    </div>
                                    <div className="grid grid-cols-[8rem_1fr_1fr] items-center gap-2 text-sm">
                                        <span />
                                        <span className="text-xs text-muted-foreground">In git (default)</span>
                                        <span className="text-xs text-muted-foreground">Override in {s.env}</span>
                                        {(['cron', 'timezone', 'parameters', 'input'] as (keyof ScheduleDefaults)[]).map(key => (
                                            <OverrideRow
                                                key={key}
                                                label={key}
                                                value={sc[key]}
                                                override={row?.override[key]}
                                                disabled={!row}
                                                onChange={v => {
                                                    const override = { ...row!.override };
                                                    if (v === undefined) {
                                                        delete override[key];
                                                    } else {
                                                        override[key] = v;
                                                    }
                                                    act(d => setScheduleOverride(d, sc.id, override));
                                                }}
                                            />
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                        <Button
                            variant="outline"
                            disabled={!!refusal}
                            onClick={() =>
                                act(d =>
                                    changeFlow(
                                        d,
                                        flow.id,
                                        doc => {
                                            const n = (doc.schedules?.length ?? 0) + 1;
                                            doc.schedules = [
                                                ...(doc.schedules ?? []),
                                                {
                                                    id: `s-${shortHash(flow.id + n + d.seq)}`,
                                                    name: `Every hour ${n}`,
                                                    cron: '0 * * * *',
                                                    timezone: 'UTC',
                                                    parameters: '{}',
                                                    input: '{}',
                                                },
                                            ];
                                        },
                                        'schedule added',
                                    ),
                                )
                            }
                        >
                            <Plus /> Add a schedule (a change in the flow file)
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

function OverrideRow({
    label,
    value,
    override,
    disabled,
    onChange,
}: {
    label: string;
    value: string;
    override: string | undefined;
    disabled: boolean;
    onChange: (v: string | undefined) => void;
}) {
    return (
        <>
            <span className="text-xs">{label}</span>
            <span className={cn('font-mono text-xs', override !== undefined && 'text-muted-foreground line-through')}>{value}</span>
            <span className="flex items-center gap-1">
                <Input
                    className="h-7 font-mono text-xs"
                    placeholder="(git's)"
                    disabled={disabled}
                    value={override ?? ''}
                    onChange={e => onChange(e.target.value === '' ? undefined : e.target.value)}
                />
            </span>
        </>
    );
}
