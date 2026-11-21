import { useEffect } from 'react';
import type { ScriptExport } from '@flowtinus/core';
import { api, API_WRITE_DONE } from '@/lib/api';
import { CHANGES_CHANGED } from '@/data/git/git-api';
import { useWorkspaceHandle } from '@/data/workspaces/use-workspace';
import { keyedStore } from '@/lib/keyed-store';

export type WorkspaceScript = { projectId: string; path: string; importPath: string; exports: ScriptExport[] };

export type WorkspaceProject = { id: string; name: string; handle: string; scripts: WorkspaceScript[] };

export type WorkspaceScripts = { status: 'loading' | 'ready' | 'error'; projects: WorkspaceProject[] };

const EMPTY: WorkspaceScripts = { status: 'loading', projects: [] };

const store = keyedStore(EMPTY);
const loaded = new Set<string>();
const followers = new Map<string, { count: number; reload: () => void }>();

export const workspaceScripts = store.get;

export const allScripts = (scripts: WorkspaceScripts): WorkspaceScript[] => scripts.projects.flatMap(p => p.scripts);

export const scriptByImport = (scripts: WorkspaceScripts, importPath: string) => allScripts(scripts).find(s => s.importPath === importPath);

export const watchWorkspaceScripts = store.subscribe;

type ListDto = { projects: (Omit<WorkspaceProject, 'scripts'> & { scripts: Omit<WorkspaceScript, 'projectId'>[] })[] };

export async function reloadWorkspaceScripts(workspace: string): Promise<void> {
    loaded.add(workspace);
    const result = await api<ListDto>(`/w/${workspace}/scripts`);
    store.set(
        workspace,
        result.ok
            ? {
                  status: 'ready',
                  projects: result.value.projects.map(p => ({ ...p, scripts: p.scripts.map(s => ({ ...s, projectId: p.id })) })),
              }
            : { status: 'error' },
    );
}

export function useWorkspaceScripts(): WorkspaceScripts {
    const workspace = useWorkspaceHandle();
    useEffect(() => {
        if (!workspace) {
            return;
        }
        if (!loaded.has(workspace)) {
            void reloadWorkspaceScripts(workspace);
        }
        let follower = followers.get(workspace);
        if (!follower) {
            const reload = () => void reloadWorkspaceScripts(workspace);
            follower = { count: 0, reload };
            followers.set(workspace, follower);
            window.addEventListener(API_WRITE_DONE, reload);
            window.addEventListener(CHANGES_CHANGED, reload);
        }
        follower.count++;
        return () => {
            follower.count--;
            if (follower.count === 0) {
                window.removeEventListener(API_WRITE_DONE, follower.reload);
                window.removeEventListener(CHANGES_CHANGED, follower.reload);
                followers.delete(workspace);
            }
        };
    }, [workspace]);
    return store.use(workspace);
}
