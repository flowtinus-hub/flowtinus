import { useContext, useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Database, ExternalLink, FolderKanban, FolderTree, GitCompareArrows, Network, Plug, RotateCcw, Settings, Wand2 } from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { ThemeToggle } from '@/layout/theme-toggle';
import { cn } from '@/lib/utils';
import { aheadFiles, branchOf, brokenLineage, topology, type State } from './model';
import { brokenPush, cancelMerge, currentBranch, currentChanges, finishMerge, laptopBranch, outsideCommit, pendingMergeResult, server, teammateChangesSyncOrders, update } from './actions';
import { BranchPicker, ChromeContext } from './branch-picker';
import { ChangesPanel, ConflictDialog } from './changes-panel';
import { PrototypeStore, useStore } from './store';
import { BASE, Pill, when } from './ui';

const VARIANTS = [
    { key: 'A', name: 'Top bar + drawer' },
    { key: 'B', name: 'Sidebar + page' },
];

export function PrototypeRoot() {
    return (
        <PrototypeStore>
            <Chrome />
        </PrototypeStore>
    );
}

function Chrome() {
    const { state, act } = useStore();
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const [changesOpen, setChangesOpen] = useState(false);
    const [message, setMessage] = useState('');
    const variant = params.get('variant') ?? state.session.variant;

    useEffect(() => {
        if (!params.get('variant')) {
            setParams(p => (p.set('variant', state.session.variant), p), { replace: true });
        } else if (params.get('variant') !== state.session.variant) {
            act(d => void (d.session.variant = params.get('variant')!));
        }
    }, [params, setParams, state.session.variant, act]);

    const chrome = {
        openChanges: (drawer?: boolean) => (variant === 'B' && !drawer ? navigate(`${BASE}/changes?variant=B`) : setChangesOpen(true)),
        startUpdate: () => {
            const result = act(d => update(d));
            if (result.error) {
                setMessage(result.error);
            }
        },
    };

    return (
        <ChromeContext.Provider value={chrome}>
            <Outlet />
            <Sheet open={changesOpen} onOpenChange={setChangesOpen}>
                <SheetContent className="overflow-x-hidden overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-[min(60rem,90vw)]">
                    <SheetHeader>
                        <SheetTitle>Changes</SheetTitle>
                        <SheetDescription>
                            On the canvas the changes panel is always a drawer; in layout A the top bar opens it too.
                        </SheetDescription>
                    </SheetHeader>
                    <div className="px-4 pb-6">
                        <ChangesPanel />
                    </div>
                </SheetContent>
            </Sheet>
            <PendingMergeDialog />
            {message && (
                <div className="fixed top-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border bg-popover px-4 py-2 text-sm shadow-lg">
                    {message}{' '}
                    <Button size="xs" variant="ghost" onClick={() => setMessage('')}>
                        OK
                    </Button>
                </div>
            )}
            <PrototypeBar variant={variant} />
            <Toasts state={state} />
        </ChromeContext.Provider>
    );
}

export function ChangesButton({ canvas, drawer }: { canvas?: boolean; drawer?: boolean }) {
    const { state } = useStore();
    const { openChanges } = useContextChrome();
    if (!server(state).gitOn) {
        return null;
    }
    const count = currentChanges(state).length;
    return (
        <Button variant="outline" size="sm" className={cn(canvas && 'bg-card shadow-md')} onClick={() => openChanges(drawer)}>
            <GitCompareArrows /> Changes
            <span
                className={cn(
                    'rounded-full px-1.5 text-[10px]',
                    count ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                )}
            >
                {count}
            </span>
        </Button>
    );
}

const useContextChrome = () => useContext(ChromeContext);

export function EnvPill() {
    const { state } = useStore();
    const s = server(state);
    return (
        <span
            className="flex h-7 items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 font-mono text-xs font-medium text-emerald-700 dark:text-emerald-400"
            title={`Connected to the ${s.env} server (mock)`}
        >
            live · {s.env}
        </span>
    );
}

export function PrototypeShell() {
    const { state } = useStore();
    const { pathname } = useLocation();
    const [params] = useSearchParams();
    const variant = params.get('variant') ?? state.session.variant;
    const s = server(state);
    const changes = s.gitOn ? currentChanges(state).length : 0;
    const ahead = s.gitOn ? aheadFiles(state, s.env).length + (brokenLineage(state, s.env) ? 1 : 0) : 0;
    const openPrs = state.prs.filter(p => p.state === 'open').length;
    const q = `?variant=${variant}`;

    const item = (to: string, label: string, Icon: typeof FolderKanban, badge?: ReactNode, exact = false) => (
        <SidebarMenuItem key={to}>
            <SidebarMenuButton
                isActive={exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`)}
                tooltip={label}
                asChild
            >
                <NavLink to={to + q}>
                    <Icon />
                    <span>{label}</span>
                </NavLink>
            </SidebarMenuButton>
            {badge !== undefined && badge !== 0 && <SidebarMenuBadge>{badge}</SidebarMenuBadge>}
        </SidebarMenuItem>
    );

    return (
        <SidebarProvider>
            <Sidebar collapsible="icon">
                <SidebarHeader className="h-14 justify-center border-b px-3 group-data-[collapsible=icon]:px-2">
                    <SidebarTrigger className="size-8" />
                </SidebarHeader>
                <SidebarContent>
                    <SidebarGroup>
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <SidebarMenuButton size="lg">
                                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
                                        A
                                    </span>
                                    <span className="grid flex-1 text-left text-sm leading-tight">
                                        <span className="truncate font-medium">Acme</span>
                                        <span className="truncate text-xs text-muted-foreground">acme · Admin</span>
                                    </span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                            {variant === 'B' && s.gitOn && (
                                <SidebarMenuItem className="px-1 py-1 group-data-[collapsible=icon]:hidden">
                                    <BranchPicker className="w-full justify-start" />
                                </SidebarMenuItem>
                            )}
                            {item(BASE, 'Projects', FolderKanban, undefined, false)}
                            {item(`${BASE}/connections`, 'Connections', Plug)}
                            {item(`${BASE}/settings`, 'Settings', Settings)}
                        </SidebarMenu>
                    </SidebarGroup>
                    {s.gitOn && (
                        <SidebarGroup>
                            <SidebarGroupLabel>Git</SidebarGroupLabel>
                            <SidebarMenu>
                                {variant === 'B' && item(`${BASE}/changes`, 'Source control', GitCompareArrows, changes)}
                                {item(`${BASE}/environments`, 'Environments', Network, ahead ? '!' : undefined)}
                                {item(`${BASE}/repo`, 'Repository', FolderTree)}
                            </SidebarMenu>
                        </SidebarGroup>
                    )}
                    <SidebarGroup className="mt-auto">
                        <SidebarGroupLabel>Outside the app (mock)</SidebarGroupLabel>
                        <SidebarMenu>{item(`${BASE}/provider`, 'Git provider', ExternalLink, openPrs)}</SidebarMenu>
                    </SidebarGroup>
                </SidebarContent>
            </Sidebar>
            <SidebarInset>
                <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
                    <SidebarTrigger className="-ml-1 md:hidden" />
                    {variant === 'A' && (
                        <div className="flex items-center gap-2">
                            <BranchPicker />
                            <ChangesButton />
                        </div>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                        <EnvPill />
                        <ThemeToggle />
                    </div>
                </header>
                <main className="flex flex-1 flex-col p-6 pb-24">
                    <Outlet />
                </main>
            </SidebarInset>
        </SidebarProvider>
    );
}

export function ChangesPage() {
    return (
        <div className="mx-auto grid w-full max-w-3xl gap-4">
            <h1 className="text-2xl font-semibold">Source control</h1>
            <p className="text-sm text-muted-foreground">
                The branch picker sits under the workspace; this page is its changes, commit, update and pull request.
            </p>
            <ChangesPanel />
        </div>
    );
}

function PrototypeBar({ variant }: { variant: string }) {
    const { state, act, reset } = useStore();
    const [, setParams] = useSearchParams();
    const [debug, setDebug] = useState(false);
    const index = VARIANTS.findIndex(v => v.key === variant);
    const cycle = (step: number) => {
        const next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length]!.key;
        setParams(p => (p.set('variant', next), p), { replace: true });
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target instanceof Element ? e.target : null;
            if (target?.closest('input, textarea, select, [contenteditable]')) {
                return;
            }
            if (e.key === 'ArrowLeft' && e.altKey) {
                cycle(-1);
            } else if (e.key === 'ArrowRight' && e.altKey) {
                cycle(1);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    return (
        <>
            <div className="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border-2 border-fuchsia-500 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-100 shadow-xl">
                <span className="rounded-full bg-fuchsia-500 px-2 py-0.5 font-bold text-white">PROTOTYPE</span>
                <label className="flex items-center gap-1" title="Prototype only: each environment is a different server in reality">
                    running as
                    <select
                        className="rounded bg-zinc-800 px-1 py-0.5 font-mono"
                        value={state.session.env}
                        onChange={e => act(d => void (d.session.env = e.target.value))}
                    >
                        {state.envOrder.map(env => (
                            <option key={env} value={env}>
                                {env} server
                            </option>
                        ))}
                    </select>
                </label>
                <label className="flex items-center gap-1">
                    user
                    <select
                        className="rounded bg-zinc-800 px-1 py-0.5"
                        value={state.session.user}
                        onChange={e => act(d => void (d.session.user = e.target.value))}
                    >
                        {state.users.map(u => (
                            <option key={u.slug} value={u.slug}>
                                {u.name}
                            </option>
                        ))}
                    </select>
                </label>
                <span className="mx-1 h-4 w-px bg-zinc-700" />
                <button type="button" aria-label="Previous layout" onClick={() => cycle(-1)}>
                    <ChevronLeft className="size-4" />
                </button>
                <span title="Layout variant (?variant=), Alt+Left/Right">
                    {variant} ({VARIANTS[index]?.name ?? '?'})
                </span>
                <button type="button" aria-label="Next layout" onClick={() => cycle(1)}>
                    <ChevronRight className="size-4" />
                </button>
                <span className="mx-1 h-4 w-px bg-zinc-700" />
                <DropdownMenu>
                    <DropdownMenuTrigger className="flex items-center gap-1">
                        <Wand2 className="size-3.5" /> Simulate
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" className="w-96">
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Things other people or systems do</DropdownMenuLabel>
                        <DropdownMenuItem onSelect={() => act(d => teammateChangesSyncOrders(d))}>
                            Bruno's change to "Sync orders" reaches dev (sets up a conflict)
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => act(d => outsideCommit(d, 'dev'))}>
                            Someone pushes straight to dev in git
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => act(d => outsideCommit(d, 'prod'))}>
                            An admin pushes straight to prod, past the protection
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => act(d => brokenPush(d, 'dev'))}>
                            Someone pushes to dev a tree that is not valid (a script a flow still calls is deleted)
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => act(d => laptopBranch(d))}>
                            A developer pushes fix/refunds-timeout from VS Code (a branch the app did not create)
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                <button type="button" className="flex items-center gap-1" onClick={() => setDebug(true)}>
                    <Database className="size-3.5" /> State
                </button>
                <button type="button" className="flex items-center gap-1" onClick={reset} title="Back to the seed">
                    <RotateCcw className="size-3.5" /> Reset
                </button>
            </div>
            <DebugDrawer open={debug} onOpenChange={setDebug} />
        </>
    );
}

function DebugDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { state } = useStore();
    const commits = Object.values(state.commits)
        .sort((a, b) => b.at - a.at)
        .map(c => `${c.sha} ${c.kind.padEnd(9)} ${when(c.at)} [${c.parents.join(',')}] ${c.author}: ${c.message}`);
    const branches = Object.entries(state.branches).map(([b, sha]) => `${b.padEnd(32)} ${sha}`);
    const servers = Object.fromEntries(
        state.envOrder.map(env => {
            const s = state.servers[env]!;
            return [
                env,
                {
                    gitOn: s.gitOn,
                    settings: s.settings,
                    branch: branchOf(state, env),
                    refused: s.refused,
                    pins: s.pins,
                    reconciledSha: s.reconciledSha,
                    deployments: Object.fromEntries(
                        Object.values(s.flows).map(f => [
                            f.name,
                            {
                                current: f.current,
                                versions: f.versions.map(v => `v${v.n}@${v.sha ?? 'deploy'}${v.deployedField ? '' : ' (deployed:false)'}`),
                            },
                        ]),
                    ),
                    schedules: s.schedules,
                    connections: s.connections,
                    scriptsDeployed: s.scripts,
                    workingCopies: Object.fromEntries(
                        Object.entries(s.working).map(([b, o]) => [
                            b,
                            Object.fromEntries(Object.entries(o).map(([p, v]) => [p, v === null ? 'DELETED' : `${v.length} chars`])),
                        ]),
                    ),
                    workingCopyMeta: s.workingMeta,
                    deploymentHistory: s.history.slice(0, 15),
                },
            ];
        }),
    );
    const section = (title: string, body: string) => (
        <details open className="grid gap-1">
            <summary className="cursor-pointer text-sm font-semibold">{title}</summary>
            <pre className="overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-4">{body}</pre>
        </details>
    );
    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
                <SheetHeader>
                    <SheetTitle>Mock state (prototype)</SheetTitle>
                    <SheetDescription>
                        Session: {state.session.env} server, user {state.session.user}, branch {currentBranch(state)}
                    </SheetDescription>
                </SheetHeader>
                <div className="grid gap-3 px-4 pb-6">
                    {section('Topology (topology.yaml on flowtinus/config)', JSON.stringify(topology(state), null, 2))}
                    {section('Branches (the shared repo)', branches.join('\n'))}
                    {section(
                        'Open / merged PRs (the provider)',
                        state.prs
                            .map(
                                p =>
                                    `!${p.number} ${p.state.padEnd(6)} ${p.kind.padEnd(9)} ${p.from} -> ${p.to}${p.mergeSha ? ` @${p.mergeSha}` : ''}: ${p.title}`,
                            )
                            .join('\n') || '-',
                    )}
                    {section('Commits (newest first)', commits.join('\n'))}
                    {section('Each server (its own Postgres)', JSON.stringify(servers, null, 2))}
                    {section('Activity', state.events.map(e => `${when(e.at)} ${e.text}`).join('\n'))}
                </div>
            </SheetContent>
        </Sheet>
    );
}

function Toasts({ state }: { state: State }) {
    const [shown, setShown] = useState<number>(0);
    const latest = state.events[0];
    useEffect(() => {
        if (!latest) {
            return;
        }
        const timer = setTimeout(() => setShown(latest.id), 5000);
        return () => clearTimeout(timer);
    }, [latest]);
    const recent = state.events.filter(e => e.id > shown).slice(0, 3);
    if (!latest || recent.length === 0) {
        return null;
    }
    return (
        <div className="fixed right-4 bottom-16 z-50 grid w-96 gap-2">
            {recent.map(e => (
                <div key={e.id} className="rounded-lg border bg-popover px-3 py-2 text-sm shadow-lg">
                    <Pill tone={e.tone === 'ok' ? 'ok' : e.tone === 'warn' ? 'warn' : e.tone === 'error' ? 'bad' : 'info'} className="mr-2">
                        {e.tone}
                    </Pill>
                    {e.text}
                </div>
            ))}
        </div>
    );
}

function PendingMergeDialog() {
    const { state, act } = useStore();
    const pending = state.session.pendingMerge?.env === state.session.env ? state.session.pendingMerge : null;
    const conflicts = pending ? pendingMergeResult(state).conflicts : [];
    return (
        <ConflictDialog
            conflicts={pending && conflicts.length ? conflicts : null}
            title={`${pending?.message ?? ''}: ${conflicts.length} conflict(s)`}
            description={`Mine is ${pending?.branch}, theirs is ${pending?.theirs}. The result must be valid before the merge commit.`}
            onCancel={() => act(d => cancelMerge(d))}
            onSubmit={resolution => act(d => finishMerge(d, resolution))}
        />
    );
}
