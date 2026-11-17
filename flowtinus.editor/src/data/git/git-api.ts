import { api } from '@/lib/api';

export type GitConfig = { repository: string; tokenSecret: string; environment: string };

export type Mode = 'direct' | 'pull-request' | 'protected';

export type EnvironmentDecl = { env: string; label: string; branch: string; promotesTo: string[]; mode: Mode };

export type Topology =
    | { exists: false }
    | {
          exists: true;
          commit: string;
          environments: EnvironmentDecl[];
          problems: string[];
          environment: EnvironmentDecl | null;
          branchExists: boolean;
      };

export type AccessTest = {
    ok: boolean;
    checks: { step: 'read' | 'write'; ok: boolean; message: string }[];
    topology: Topology | null;
    note: string;
};

export const CONFIG_BRANCH = 'flowtinus/config';

export const getGitConfig = (ws: string) => api<{ config: GitConfig | null }>(`/w/${ws}/git`);

export const saveGitConfig = (ws: string, config: GitConfig) => api<{ config: GitConfig }>(`/w/${ws}/git`, { method: 'PUT', body: config });

export const removeGitConfig = (ws: string) => api<{ config: null }>(`/w/${ws}/git`, { method: 'DELETE' });

/** a configuration, saved or not: pushes and deletes a throwaway branch */
export const testGitAccess = (ws: string, config: GitConfig) => api<AccessTest>(`/w/${ws}/git/test`, { method: 'POST', body: config });

export const getTopology = (ws: string) => api<{ topology: Topology }>(`/w/${ws}/git/topology`);

export const createTopology = (ws: string, environment: { label?: string; branch?: string }) =>
    api<{ topology: Topology }>(`/w/${ws}/git/topology`, { method: 'POST', body: { confirm: true, ...environment } });
