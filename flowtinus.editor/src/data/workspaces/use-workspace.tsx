import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { getCurrentWorkspace, type ApiError } from '@/lib/api';
import { getMe } from './workspaces-api';
import { roleAtLeast, type Me, type Membership } from './workspace';

/*
 * Who is using the editor and their workspaces (/me), loaded once for every page; and the workspace of the page (the
 * :ws of its address), with the user's role in it.
 */

type MeState = { status: 'loading' } | { status: 'error'; error: ApiError } | { status: 'ready'; me: Me };

const MeContext = createContext<{ state: MeState; reload: () => Promise<void> }>({
    state: { status: 'loading' },
    reload: async () => {},
});

export function MeProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<MeState>({ status: 'loading' });
    const reload = useCallback(async () => {
        const result = await getMe();
        setState(result.ok ? { status: 'ready', me: result.value } : { status: 'error', error: result.error });
    }, []);
    useEffect(() => {
        void reload();
    }, [reload]);
    const value = useMemo(() => ({ state, reload }), [state, reload]);
    return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

/** the user and their workspaces; `reload` after creating, archiving or leaving one */
export const useMe = () => useContext(MeContext);

/** the handle of the page's workspace (its address' :ws) */
export function useWorkspaceHandle(): string {
    const { ws } = useParams();
    return ws ?? getCurrentWorkspace();
}

/** the page's workspace as the user is in it (name, role), once /me answered; and whether the user may change things */
export function useWorkspace(): { handle: string; membership: Membership | null; canEdit: boolean; isAdmin: boolean } {
    const handle = useWorkspaceHandle();
    const { state } = useMe();
    const membership = state.status === 'ready' ? (state.me.workspaces.find(w => w.handle === handle) ?? null) : null;
    // while /me loads, nothing is hidden (the api refuses what the role does not allow)
    const role = state.status === 'ready' ? membership?.role : 'admin';
    return { handle, membership, canEdit: roleAtLeast(role, 'editor'), isAdmin: roleAtLeast(role, 'admin') };
}

const LAST_KEY = 'flowtinus.lastWorkspace';

/** the workspace last opened in this browser (where / goes) */
export function lastWorkspace(): string | null {
    try {
        return localStorage.getItem(LAST_KEY);
    } catch {
        return null;
    }
}

export function rememberWorkspace(handle: string) {
    try {
        localStorage.setItem(LAST_KEY, handle);
    } catch {
        // private mode: / then goes to the list
    }
}

/** the workspace in the menu: the page's, else the one last used (on the environment's pages: Runs, Workers) */
export function useMenuWorkspace(workspaces: Membership[]): Membership | null {
    const { ws } = useParams();
    const handle = ws ?? lastWorkspace();
    return workspaces.find(w => w.handle === handle) ?? workspaces[0] ?? null;
}
