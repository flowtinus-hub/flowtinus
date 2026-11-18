import { Check, ChevronsUpDown, FolderKanban, History, KeyRound, LayoutGrid, Plug, Plus, Settings, TriangleAlert, GitPullRequest } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getGitStatus, GIT_STATUS_CHANGED, gitAhead, ONLY_PULL_REQUESTS, type GitStatus } from '@/data/git/git-api';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { connectionsPath, projectsPath, RUNS_PATH, secretsPath, WORKERS_PATH, workspaceSettingsPath, WORKSPACES_PATH } from '@/app/paths';
import { mockUser } from '@/auth/mock-user';
import { lastWorkspace, useMe } from '@/data/workspaces/use-workspace';
import { ROLE_LABEL, type Membership } from '@/data/workspaces/workspace';
import { NewWorkspaceDialog } from '@/pages/workspaces/new-workspace-dialog';
import { NavUser } from './nav-user';
import { WorkerIcon } from '@/components/worker-icon';

// an item is also active on its sub-pages (/w/dev/projects/...)
const isActive = (to: string, pathname: string) => pathname === to || pathname.startsWith(`${to}/`);

/** the workspace in the menu: the page's, else the one last used (on the environment's pages: Runs, Workers) */
function useMenuWorkspace(workspaces: Membership[]): Membership | null {
    const { ws } = useParams();
    const slug = ws ?? lastWorkspace();
    return workspaces.find(w => w.slug === slug) ?? workspaces[0] ?? null;
}

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
                                {current ? `${current.slug} · ${ROLE_LABEL[current.role]}` : 'Choose one'}
                            </span>
                        </span>
                        <ChevronsUpDown className="ml-auto group-data-[collapsible=icon]:hidden" />
                    </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="min-w-64" side={isMobile ? 'bottom' : 'right'} align="start">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
                    {workspaces.map(w => (
                        <DropdownMenuItem key={w.slug} onSelect={() => navigate(projectsPath(w.slug))}>
                            <span className="truncate">{w.name}</span>
                            <span className="ml-auto text-xs text-muted-foreground">{w.slug}</span>
                            {w.slug === current?.slug && <Check />}
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

/** with git on, when git is ahead of the deploy (a refused commit, or unreachable): a line to the git section */
function GitAheadItem({ slug, pathname }: { slug: string; pathname: string }) {
    const [status, setStatus] = useState<{ slug: string; value: GitStatus } | null>(null);
    useEffect(() => {
        let gone = false;
        const read = () => void getGitStatus(slug).then(result => !gone && result.ok && setStatus({ slug, value: result.value }));
        read();
        const timer = setInterval(read, GIT_STATUS_MS);
        window.addEventListener(GIT_STATUS_CHANGED, read);
        return () => {
            gone = true;
            clearInterval(timer);
            window.removeEventListener(GIT_STATUS_CHANGED, read);
        };
    }, [slug, pathname]);

    const value = status?.slug === slug ? status.value : null;
    if (value?.on && !gitAhead(value) && value.mode !== 'direct') {
        return (
            <SidebarMenuItem>
                <SidebarMenuButton tooltip={ONLY_PULL_REQUESTS} asChild className="text-muted-foreground">
                    <NavLink to={`${workspaceSettingsPath(slug)}#git`} title={ONLY_PULL_REQUESTS}>
                        <GitPullRequest />
                        <span>Pull requests only</span>
                    </NavLink>
                </SidebarMenuButton>
            </SidebarMenuItem>
        );
    }
    if (!value || !gitAhead(value) || !value.on) {
        return null;
    }
    const label = value.refused ? 'Git is ahead: commit refused' : 'Git unreachable';
    return (
        <SidebarMenuItem>
            <SidebarMenuButton tooltip={label} asChild className="text-amber-700 dark:text-amber-400">
                <NavLink to={`${workspaceSettingsPath(slug)}#git`}>
                    <TriangleAlert />
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

    // the current workspace's pages; the environment's at the bottom
    const workspaceItems = current
        ? [
              { to: projectsPath(current.slug), label: 'Projects', icon: FolderKanban },
              { to: connectionsPath(current.slug), label: 'Connections', icon: Plug },
              { to: secretsPath(current.slug), label: 'Secrets and Variables', icon: KeyRound },
              { to: workspaceSettingsPath(current.slug), label: 'Settings', icon: Settings },
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
                        {current && <GitAheadItem slug={current.slug} pathname={pathname} />}
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
