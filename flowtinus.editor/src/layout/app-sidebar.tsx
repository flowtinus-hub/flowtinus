import { Check, ChevronsUpDown, FolderKanban, History, KeyRound, LayoutGrid, Plug, Plus, Settings, TriangleAlert, GitPullRequest, CirclePause, Layers } from 'lucide-react';
import { useEffect, useState } from 'react';
import { arrivedCount, CHANGES_CHANGED, getGitStatus, GIT_STATUS_CHANGED, gitAhead, listArrivedDisabled, ONLY_PULL_REQUESTS, TRIGGERS_SWITCHED, type GitStatus } from '@/data/git/git-api';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { connectionsPath, environmentsPath, projectsPath, RUNS_PATH, secretsPath, WORKERS_PATH, workspaceSettingsPath, WORKSPACES_PATH } from '@/app/paths';
import { mockUser } from '@/auth/mock-user';
import { useMe, useMenuWorkspace } from '@/data/workspaces/use-workspace';
import { ROLE_LABEL, type Membership } from '@/data/workspaces/workspace';
import { NewWorkspaceDialog } from '@/pages/workspaces/new-workspace-dialog';
import { NavUser } from './nav-user';
import { WorkerIcon } from '@/components/worker-icon';
import { isLocalServer, useServerConnection } from '@/lib/server-connection';
import { DiskStatusItem } from './disk-status-item';

// an item is also active on its sub-pages (/w/dev/projects/...)
const isActive = (to: string, pathname: string) => pathname === to || pathname.startsWith(`${to}/`);

/** the workspace's name at the top of the menu; a click: the user's other workspaces, all of them, a new one (admins of the environment) */
function WorkspaceSwitcher({
    current,
    workspaces,
    canCreate,
}: {
    current: Membership | null;
    workspaces: Membership[];
    canCreate: boolean;
}) {
    const navigate = useNavigate();
    const { isMobile } = useSidebar();
    const [creating, setCreating] = useState(false);

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <SidebarMenuButton size="lg" tooltip={current?.name ?? 'Workspaces'} aria-label="Switch workspace">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
                            {(current?.name ?? 'W').slice(0, 1).toUpperCase()}
                        </span>
                        <span className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                            <span className="truncate font-medium">{current?.name ?? 'No workspace'}</span>
                            <span className="truncate text-xs text-muted-foreground">
                                {current ? `${current.handle} · ${ROLE_LABEL[current.role]}` : 'Choose one'}
                            </span>
                        </span>
                        <ChevronsUpDown className="ml-auto group-data-[collapsible=icon]:hidden" />
                    </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="min-w-64" side={isMobile ? 'bottom' : 'right'} align="start">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
                    {workspaces.map(w => (
                        <DropdownMenuItem key={w.handle} onSelect={() => navigate(projectsPath(w.handle))}>
                            <span className="truncate">{w.name}</span>
                            <span className="ml-auto text-xs text-muted-foreground">{w.handle}</span>
                            {w.handle === current?.handle && <Check />}
                        </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => navigate(WORKSPACES_PATH)}>
                        <LayoutGrid /> All workspaces
                    </DropdownMenuItem>
                    {canCreate && (
                        <DropdownMenuItem onSelect={() => setCreating(true)}>
                            <Plus /> New workspace
                        </DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <NewWorkspaceDialog open={creating} onOpenChange={setCreating} />
        </>
    );
}

/** looked at again on this interval, and on each page */
const GIT_STATUS_MS = 60_000;
const DISK_STATUS_MS = 5_000;

function useGitStatus(handle: string | null, pathname: string): GitStatus | null {
    const [status, setStatus] = useState<{ handle: string; value: GitStatus } | null>(null);
    const local = isLocalServer(useServerConnection());
    useEffect(() => {
        if (!handle) {
            return;
        }
        let gone = false;
        const read = () => void getGitStatus(handle).then(result => !gone && result.ok && setStatus({ handle, value: result.value }));
        read();
        const timer = setInterval(read, local ? DISK_STATUS_MS : GIT_STATUS_MS);
        window.addEventListener(GIT_STATUS_CHANGED, read);
        return () => {
            gone = true;
            clearInterval(timer);
            window.removeEventListener(GIT_STATUS_CHANGED, read);
        };
    }, [handle, pathname, local]);

    return status?.handle === handle ? status.value : null;
}

function GitItems({ handle, pathname, value }: { handle: string; pathname: string; value: GitStatus | null }) {
    if (value && !value.on && value.disk) {
        return (
            <>
                <DiskStatusItem disk={value.disk} />
                <ArrivedDisabledItem handle={handle} pathname={pathname} />
            </>
        );
    }
    return value?.on ? (
        <>
            <GitAheadItem handle={handle} value={value} />
            <ArrivedDisabledItem handle={handle} pathname={pathname} />
        </>
    ) : null;
}

function GitAheadItem({ handle, value }: { handle: string; value: Extract<GitStatus, { on: true }> }) {
    if (!gitAhead(value) && value.mode !== 'direct') {
        return (
            <SidebarMenuItem>
                <SidebarMenuButton tooltip={ONLY_PULL_REQUESTS} asChild className="text-muted-foreground">
                    <NavLink to={environmentsPath(handle)} title={ONLY_PULL_REQUESTS}>
                        <GitPullRequest />
                        <span>Pull requests only</span>
                    </NavLink>
                </SidebarMenuButton>
            </SidebarMenuItem>
        );
    }
    if (!gitAhead(value)) {
        return null;
    }
    const label = value.refused ? 'Git is ahead: commit refused' : 'Git unreachable';
    return (
        <SidebarMenuItem>
            <SidebarMenuButton tooltip={label} asChild className="text-amber-700 dark:text-amber-400">
                <NavLink to={environmentsPath(handle)}>
                    <TriangleAlert />
                    <span>{label}</span>
                </NavLink>
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}

function ArrivedDisabledItem({ handle, pathname }: { handle: string; pathname: string }) {
    const [count, setCount] = useState<{ handle: string; value: number } | null>(null);
    useEffect(() => {
        let gone = false;
        const read = () =>
            void listArrivedDisabled(handle).then(result => !gone && result.ok && setCount({ handle, value: arrivedCount(result.value) }));
        read();
        const timer = setInterval(read, GIT_STATUS_MS);
        const events = [GIT_STATUS_CHANGED, CHANGES_CHANGED, TRIGGERS_SWITCHED];
        events.forEach(event => window.addEventListener(event, read));
        return () => {
            gone = true;
            clearInterval(timer);
            events.forEach(event => window.removeEventListener(event, read));
        };
    }, [handle, pathname]);

    const value = count?.handle === handle ? count.value : 0;
    if (value === 0) {
        return null;
    }
    const label = `${value} trigger${value === 1 ? '' : 's'} arrived disabled`;
    return (
        <SidebarMenuItem>
            <SidebarMenuButton tooltip={label} asChild className="text-sky-700 dark:text-sky-400">
                <NavLink to={`${workspaceSettingsPath(handle)}?tab=git#git`} title="Off until turned on in this environment">
                    <CirclePause />
                    <span>{label}</span>
                </NavLink>
            </SidebarMenuButton>
        </SidebarMenuItem>
    );
}

export function AppSidebar() {
    const { pathname } = useLocation();
    const { state } = useMe();
    const workspaces = state.status === 'ready' ? state.me.workspaces : [];
    const current = useMenuWorkspace(workspaces);
    const git = useGitStatus(current?.handle ?? null, pathname);

    // the current workspace's pages; the environment's at the bottom
    const workspaceItems = current
        ? [
              { to: projectsPath(current.handle), label: 'Projects', icon: FolderKanban },
              { to: connectionsPath(current.handle), label: 'Connections', icon: Plug },
              { to: secretsPath(current.handle), label: 'Secrets and Variables', icon: KeyRound },
              ...(git?.on ? [{ to: environmentsPath(current.handle), label: 'Environments', icon: Layers }] : []),
              { to: workspaceSettingsPath(current.handle), label: 'Settings', icon: Settings },
          ]
        : [];
    const environmentItems = [
        { to: RUNS_PATH, label: 'Runs', icon: History },
        { to: WORKERS_PATH, label: 'Workers', icon: WorkerIcon },
    ];

    return (
        <Sidebar collapsible="icon">
            {/* same height and bottom border as the top bar (app-shell.tsx), so the line runs straight across; collapse/expand
                here (collapsed: icons only, the button stays where the icons are) */}
            <SidebarHeader className="h-14 justify-center border-b px-3 group-data-[collapsible=icon]:px-2">
                <SidebarTrigger className="size-8" />
            </SidebarHeader>

            <SidebarContent>
                <SidebarGroup>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <WorkspaceSwitcher
                                current={current}
                                workspaces={workspaces}
                                canCreate={state.status === 'ready' && state.me.isAdmin}
                            />
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarGroup>
                {current && (
                    // with git off every item renders nothing: the group and its lines go too
                    <SidebarGroup className="mx-2 w-auto border-y border-sidebar-border px-0 has-[>ul:empty]:hidden">
                        <SidebarMenu>
                            <GitItems handle={current.handle} pathname={pathname} value={git} />
                        </SidebarMenu>
                    </SidebarGroup>
                )}
                <SidebarGroup>
                    <SidebarMenu>
                        {workspaceItems.map(item => (
                            <SidebarMenuItem key={item.to}>
                                <SidebarMenuButton isActive={isActive(item.to, pathname)} tooltip={item.label} asChild>
                                    <NavLink to={item.to}>
                                        <item.icon />
                                        <span>{item.label}</span>
                                    </NavLink>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        ))}
                    </SidebarMenu>
                </SidebarGroup>
                {/* the environment's pages (not a workspace's), at the bottom */}
                <SidebarGroup className="mt-auto">
                    <SidebarMenu>
                        {environmentItems.map(item => (
                            <SidebarMenuItem key={item.to}>
                                <SidebarMenuButton isActive={isActive(item.to, pathname)} tooltip={item.label} asChild>
                                    <NavLink to={item.to}>
                                        <item.icon />
                                        <span>{item.label}</span>
                                    </NavLink>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        ))}
                    </SidebarMenu>
                </SidebarGroup>
            </SidebarContent>

            <SidebarFooter>
                <NavUser user={mockUser} />
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    );
}
