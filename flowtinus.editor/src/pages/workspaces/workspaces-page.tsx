import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { FolderKanban, KeyRound, Layers, Plug, Plus, Users } from 'lucide-react';
import { projectsPath, workspaceSettingsPath } from '@/app/paths';
import { ResourceView } from '@/components/resource-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useResource } from '@/data/use-resource';
import { useMe } from '@/data/workspaces/use-workspace';
import { ROLE_LABEL, type Workspace } from '@/data/workspaces/workspace';
import { listWorkspaces } from '@/data/workspaces/workspaces-api';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ProjectIcon } from '@/pages/flows/project-icon';
import { NewWorkspaceDialog } from './new-workspace-dialog';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** what a workspace holds, for its card */
function summaryOf(w: Workspace) {
    const s = w.summary;
    return s
        ? [
              { icon: FolderKanban, text: plural(s.projects, 'project'), title: 'Active projects' },
              { icon: Plug, text: plural(s.connections, 'connection'), title: 'Connections' },
              {
                  icon: KeyRound,
                  text: `${plural(s.secrets, 'secret')} · ${plural(s.variables, 'variable')}`,
                  title: 'Secrets and Variables',
              },
              { icon: Users, text: plural(s.members, 'member'), title: 'Members' },
          ]
        : [];
}

/** A workspace in the list: a click opens its projects; an archived one opens its settings (to restore it). */
function WorkspaceCard({ workspace }: { workspace: Workspace }) {
    const archived = workspace.archivedAt !== null;
    return (
        <Card
            className={cn(
                'relative transition-colors hover:bg-accent/40 focus-within:ring-2 focus-within:ring-ring',
                archived && 'opacity-75',
            )}
        >
            <CardHeader className="flex items-start gap-3">
                <ProjectIcon icon={workspace.icon} color={workspace.color} className={cn(archived && 'grayscale')} />
                <div className="grid min-w-0 flex-1 gap-1">
                    <CardTitle className="truncate">
                        <Link
                            to={archived ? workspaceSettingsPath(workspace.slug) : projectsPath(workspace.slug)}
                            className="outline-none after:absolute after:inset-0 after:content-['']"
                        >
                            {workspace.name}
                        </Link>
                    </CardTitle>
                    <CardDescription className="line-clamp-2 h-10 leading-5" title={workspace.description || undefined}>
                        {workspace.description || 'No description'}
                    </CardDescription>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground" title="Your role here">
                    {ROLE_LABEL[workspace.role]}
                </span>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                {summaryOf(workspace).map(item => (
                    <span key={item.title} className="inline-flex items-center gap-1.5" title={item.title}>
                        <item.icon className="size-3.5" />
                        {item.text}
                    </span>
                ))}
            </CardContent>
            <CardFooter className="mt-auto justify-between text-xs text-muted-foreground/70">
                <span className="font-mono">/w/{workspace.slug}</span>
                <span>
                    {workspace.archivedAt ? `Archived ${formatDate(workspace.archivedAt)}` : `Created ${formatDate(workspace.createdAt)}`}
                </span>
            </CardFooter>
        </Card>
    );
}

/**
 * The user's workspaces (/workspaces), active or archived (?status=archived), as cards; "New workspace" for an admin of the
 * environment.
 */
export function WorkspacesPage() {
    const [params, setParams] = useSearchParams();
    const status = params.get('status') === 'archived' ? 'archived' : 'active';
    const workspaces = useResource(`workspaces:${status}`, () => listWorkspaces(status));
    const { state } = useMe();
    const [creating, setCreating] = useState(false);

    return (
        <div className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setParams(status === 'active' ? { status: 'archived' } : {})}>
                        {status === 'active' ? 'Archived' : 'Active'}
                    </Button>
                    {state.status === 'ready' && state.me.isAdmin && (
                        <Button onClick={() => setCreating(true)}>
                            <Plus /> New workspace
                        </Button>
                    )}
                </div>
            </div>

            <ResourceView
                state={workspaces.state}
                onRetry={workspaces.reload}
                empty={{
                    icon: Layers,
                    text: status === 'active' ? 'You are not a member of any workspace yet.' : 'No archived workspaces.',
                }}
                isEmpty={items => items.length === 0}
            >
                {items => (
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {items.map(w => (
                            <WorkspaceCard key={w.id} workspace={w} />
                        ))}
                    </div>
                )}
            </ResourceView>
            <NewWorkspaceDialog open={creating} onOpenChange={setCreating} />
        </div>
    );
}
