import type { TreeIssue } from '@flowtinus/core';
import { api } from '@/lib/api';

/** pollSeconds: how often the server fetches the environment's branch (60 when absent) */
export type GitConfig = { repository: string; tokenSecret: string; environment: string; pollSeconds?: number };

/** the last fetch of the environment's branch, and why it could not reconcile */
export type LastPoll = { at: string; error?: string; since?: string };

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

/** hook (admins): the webhook's path on the server (git/hook/<workspace>/<token>) */
export const getGitConfig = (ws: string) =>
    api<{ config: GitConfig | null; on: boolean; hook?: string; lastPoll?: LastPoll }>(`/w/${ws}/git`);

export type GitCommitView = { sha: string; message?: string; author?: string; at?: string };

/** with git on: the commit the deploy is on, a refused commit git is at (errors per file), git unreachable since, warnings */
export type GitStatus =
    | { on: false }
    | {
          on: true;
          branch: string | null;
          /** not direct: this server takes the tree's changes only from git (pull requests) */
          mode: Mode;
          deploy: GitCommitView | null;
          refused: (GitCommitView & { errors: TreeIssue[]; refusedAt: string }) | null;
          unreachable: { since: string; error: string } | null;
          warnings: TreeIssue[];
          lastPoll: LastPoll | null;
      };

export const getGitStatus = (ws: string) => api<GitStatus>(`/w/${ws}/git/status`);

/** the user's current branch in the workspace (the environment's branch until another is picked; null with git off), and whether they may edit there */
export type CurrentBranch = { branch: string | null; editable: boolean };

export const getCurrentBranch = (ws: string) => api<CurrentBranch>(`/w/${ws}/git/current-branch`);

export const setCurrentBranch = (ws: string, branch: string) =>
    api<CurrentBranch>(`/w/${ws}/git/current-branch`, { method: 'PUT', body: { branch } });

/** an environment's (in the topology), a user's (users/<handle>/...: only its owner writes), or shared (anyone) */
export type BranchKind = 'environment' | 'user' | 'shared';

export type BranchInfo = {
    name: string;
    kind: BranchKind;
    /** a user's branch: the owner's handle, and name when known */
    owner?: string;
    ownerName?: string;
    mine: boolean;
    editable: boolean;
    /** contained in the environment's branch with no uncommitted change: behind "show merged" */
    merged: boolean;
    /** uncommitted changes on this server */
    changes: number;
};

/** the remote's branches as the last fetch found them (the app's own left out), by kind */
export const listBranches = (ws: string) =>
    api<{ current: string | null; environment: string | null; branches: BranchInfo[]; fetchedAt: string | null }>(`/w/${ws}/git/branches`);

/**
 * A branch cut from the current branch's tip and pushed at once; it becomes the current branch. It takes the
 * uncommitted changes along (from the environment's or a shared branch, one's own; from one's own branch, all of them).
 */
export const createBranch = (ws: string, name: string) =>
    api<{ branch: string; taken: string[] }>(`/w/${ws}/git/branches`, { method: 'POST', body: { name } });

/** said on window when the git status changed here (Reconcile now): the sidebar reads it again */
export const GIT_STATUS_CHANGED = 'flowtinus:git-status-changed';

/** what the editor says where it turns off the Commit and the tree's actions */
export const ONLY_PULL_REQUESTS = 'This environment only takes pull requests: edit in git.';

/** git ahead of the deploy: a refused commit, or git unreachable */
export const gitAhead = (status: GitStatus) => status.on && (!!status.refused || !!status.unreachable);

export type ReconcileOutcome = 'applied' | 'up-to-date' | 'refused';

/** Reconcile now: the branch's tip applied, or refused, or already applied */
export const reconcileNow = (ws: string) =>
    api<{ outcome: ReconcileOutcome; commit: string; errors: TreeIssue[]; warnings: TreeIssue[] }>(`/w/${ws}/git/reconcile`, {
        method: 'POST',
    });

/** a new token for the webhook: the old URL stops working */
export const renewHookToken = (ws: string) => api<{ hook: string }>(`/w/${ws}/git/hook-token`, { method: 'POST' });

export const saveGitConfig = (ws: string, config: GitConfig) =>
    api<{ config: GitConfig; on: boolean }>(`/w/${ws}/git`, { method: 'PUT', body: config });

export const removeGitConfig = (ws: string) => api<{ config: null }>(`/w/${ws}/git`, { method: 'DELETE' });

/** a file of the working copy of the environment's branch: a rename is one change (from: its old path) */
export type WorkingChange = {
    path: string;
    from?: string;
    change: 'added' | 'modified' | 'deleted' | 'renamed';
    kind: string;
    editedBy: string | null;
    editedByName?: string;
    mine: boolean;
    conflict?: string;
    /** what it needs to be committed with, and why */
    requires: { path: string; reason: string }[];
};

/** said on window when the working copy changed here (a Commit, a discard): the Changes item reads it again */
export const CHANGES_CHANGED = 'flowtinus:changes-changed';

export const getChanges = (ws: string) => api<{ changes: WorkingChange[] }>(`/w/${ws}/git/changes`);

export const commitChanges = (ws: string, paths: string[], message: string) =>
    api<{ commit: string }>(`/w/${ws}/git/commit`, { method: 'POST', body: { paths, message } });

export const discardChanges = (ws: string, which: { paths: string[] } | { mine: true }) =>
    api<{ discarded: string[] }>(`/w/${ws}/git/discard`, { method: 'POST', body: which });

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
