import type { TreeIssue } from '@flowtinus/core';
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

export const getGitConfig = (ws: string) => api<{ config: GitConfig | null; on: boolean }>(`/w/${ws}/git`);

export const saveGitConfig = (ws: string, config: GitConfig) =>
    api<{ config: GitConfig; on: boolean }>(`/w/${ws}/git`, { method: 'PUT', body: config });

export const removeGitConfig = (ws: string) => api<{ config: null }>(`/w/${ws}/git`, { method: 'DELETE' });

export const testGitAccess = (ws: string, config: GitConfig) => api<AccessTest>(`/w/${ws}/git/test`, { method: 'POST', body: config });

export const getTopology = (ws: string) => api<{ topology: Topology }>(`/w/${ws}/git/topology`);

export const createTopology = (ws: string, environment: { label?: string; branch?: string }) =>
    api<{ topology: Topology }>(`/w/${ws}/git/topology`, { method: 'POST', body: { confirm: true, ...environment } });

export type FileChange = { path: string; change: 'added' | 'changed' | 'removed'; note?: string };

export type { TreeIssue } from '@flowtinus/core';

export type TurnOnPlan = {
    branch: string;
    branchExists: boolean;
    case: 'export' | 'import' | 'choice';
    toGit: FileChange[];
    toServer: FileChange[];
    errors: TreeIssue[];
    warnings: TreeIssue[];
};

export type TurnOnResult = {
    outcome: 'exported' | 'imported' | 'server-replaced-git' | 'git-replaced-server';
    branch: string;
    warnings: TreeIssue[];
};

export const getTurnOnPlan = (ws: string) => api<TurnOnPlan>(`/w/${ws}/git/on`);

export const turnGitOn = (ws: string, options: { createBranch?: boolean; choice?: 'git' | 'server' }) =>
    api<TurnOnResult>(`/w/${ws}/git/on`, { method: 'POST', body: options });
