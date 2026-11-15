import { useEffect } from 'react';
import { Link, Navigate, Outlet, useLocation, useParams } from 'react-router';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { lastWorkspace, rememberWorkspace, useMe } from '@/data/workspaces/use-workspace';
import { setCurrentWorkspace } from '@/lib/api';
import { WORKSPACES_PATH } from './paths';

/**
 * The pages of a workspace (/w/:ws/...): their data calls go to it (set before they render), it is remembered as the
 * last one used (where / goes), and a workspace the user is not in says so instead of failing page by page.
 */
export function WorkspaceScope() {
    const { ws = '' } = useParams();
    setCurrentWorkspace(ws);
    const { state } = useMe();
    // an archived workspace is not in /me: its settings still open (its admins restore it there; the api says who may)
    const settings = useLocation().pathname === `/w/${ws}/settings`;
    const known = state.status !== 'ready' || settings || state.me.workspaces.some(w => w.slug === ws);
    useEffect(() => {
        if (known) {
            rememberWorkspace(ws);
        }
    }, [ws, known]);

    if (!known) {
        return (
            <div className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                <TriangleAlert className="size-8 text-destructive" />
                <p className="text-sm text-muted-foreground">The workspace "{ws}" does not exist, or you are not a member of it.</p>
                <Button variant="outline" asChild>
                    <Link to={WORKSPACES_PATH}>Your workspaces</Link>
                </Button>
            </div>
        );
    }

    // a new workspace mounts its pages again (nothing of the other one stays)
    return <Outlet key={ws} />;
}

/** /: the workspace last used in this browser (one of the user's), or the list */
export function HomeRedirect() {
    const { state } = useMe();
    if (state.status === 'loading') {
        return null;
    }

    const last = lastWorkspace();
    const workspaces = state.status === 'ready' ? state.me.workspaces : [];
    const to = workspaces.find(w => w.slug === last) ?? (workspaces.length === 1 ? workspaces[0] : undefined);
    return <Navigate to={to ? `/w/${to.slug}/projects` : WORKSPACES_PATH} replace />;
}
