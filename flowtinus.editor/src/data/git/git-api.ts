import type { FlowFile, TreeIssue } from '@flowtinus/core';
import { api } from '@/lib/api';
import type { Schedule } from '@/data/schedules/schedule';
import { toSchedule, type ScheduleDto } from '@/data/schedules/schedules-api';
import type { Webhook } from '@/data/webhooks/webhook';
import { toWebhook, type WebhookDto } from '@/data/webhooks/webhooks-api';

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

export type CurrentBranch = { branch: string | null; editable: boolean; removed?: true; lostTip?: true; offersBranch?: boolean };

export const getCurrentBranch = (ws: string) => api<CurrentBranch>(`/w/${ws}/git/current-branch`);

export const setCurrentBranch = (ws: string, branch: string) =>
    api<CurrentBranch>(`/w/${ws}/git/current-branch`, { method: 'PUT', body: { branch } });

export type BranchKind = 'environment' | 'user' | 'shared';

export type BranchInfo = {
    name: string;
    kind: BranchKind;
    owner?: string;
    ownerName?: string;
    mine: boolean;
    editable: boolean;
    merged: boolean;
    changes: number;
    removed?: true;
    lostTip?: true;
};

export const REMOVED_BRANCH = 'Removed on the remote: create a branch with its changes, or discard them.';

export const removedBranchText = (lostTip?: boolean) =>
    lostTip
        ? `${REMOVED_BRANCH} It was removed while git was off: its last commit is not known here, so a new branch starts from the environment's branch.`
        : REMOVED_BRANCH;

export const listBranches = (ws: string) =>
    api<{ current: string | null; environment: string | null; mode: Mode; branches: BranchInfo[]; fetchedAt: string | null }>(
        `/w/${ws}/git/branches`,
    );

export type PullRequest = {
    branch: string;
    target: string;
    pushed: boolean;
    commits: number;
    borrowed: { branch: string; commits: number }[];
    provider: 'gitlab' | 'github' | null;
    url: string | null;
};

export const openPullRequest = (ws: string) => api<PullRequest>(`/w/${ws}/git/pull-request`, { method: 'POST' });

export const createBranch = (ws: string, name: string, draft?: { flowId: string; flow: FlowFile }) =>
    api<{ branch: string; taken: string[]; cutFrom?: string; draft?: { revision: number } | { error: string } }>(`/w/${ws}/git/branches`, {
        method: 'POST',
        body: draft ? { name, draft } : { name },
    });

export const branchNamePart = (name: string) =>
    name
        .trim()
        .replace(/[\s~^:?*[\\\x00-\x1f\x7f]+|\.\.+|@\{/g, '-')
        .replace(/^[-./]+|[-./]+$|\.lock$/g, '');

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

export type WorkingChange = {
    path: string;
    from?: string;
    change: 'added' | 'modified' | 'deleted' | 'renamed';
    kind: string;
    fileId: string | null;
    editedBy: string | null;
    editedByName?: string;
    mine: boolean;
    conflict?: string;
    requires: { path: string; reason: string }[];
};

/** the files a commit of `chosen` has to take along (a folder's file, a script a flow imports), with why */
export function requiredBy(changes: WorkingChange[], chosen: Set<string>): Map<string, string> {
    const byPath = new Map(changes.map(c => [c.path, c]));
    const locked = new Map<string, string>();
    const queue = [...chosen];
    while (queue.length > 0) {
        for (const { path, reason } of byPath.get(queue.shift()!)?.requires ?? []) {
            if (!locked.has(path) && !chosen.has(path)) {
                locked.set(path, reason);
                queue.push(path);
            }
        }
    }
    return locked;
}

/** the other files a discard of `path` takes along: those that need it as it is (the server's rule, withDependents) */
export function discardedWith(changes: WorkingChange[], path: string): string[] {
    const all = new Map(changes.filter(c => c.path === path).map(c => [c.path, c]));
    for (let grew = true; grew;) {
        grew = false;
        const needed = [...all.values()].filter(c => c.change !== 'modified').map(c => c.path);
        for (const change of changes.filter(c => !all.has(c.path))) {
            if (change.requires.some(r => needed.includes(r.path))) {
                all.set(change.path, change);
                grew = true;
            }
        }
    }
    all.delete(path);
    return [...all.keys()];
}

export const CHANGES_CHANGED = 'flowtinus:changes-changed';

export type PendingMerge = { from: string; theirs: string; ours: string; conflicts: string[] };

export const getChanges = (ws: string) =>
    api<{ changes: WorkingChange[]; merge?: PendingMerge; removed?: true; lostTip?: true }>(`/w/${ws}/git/changes`);

export type DiffLine = { kind: ' ' | '-' | '+'; text: string; old?: number; new?: number };

export type DiffHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] };

export type FileDiff = { path: string; from?: string; change: WorkingChange['change']; kind: string; hunks: DiffHunk[] };

export const getFileDiff = (ws: string, path: string) => api<FileDiff>(`/w/${ws}/git/diff?path=${encodeURIComponent(path)}`);

export type UpdateStatus = { branch: string; environment: string; behind: number; pending?: PendingMerge };

export const getUpdateStatus = (ws: string) => api<UpdateStatus>(`/w/${ws}/git/update`);

export type UpdateOutcome =
    | { outcome: 'up-to-date' }
    | { outcome: 'merged'; commit: string }
    | { outcome: 'pending'; conflicts: string[]; errors?: Record<string, string> };

export const updateBranch = (ws: string) => api<UpdateOutcome>(`/w/${ws}/git/update`, { method: 'POST' });

export type ArrivedDisabled = { flowId: string; flowName: string; projectId: string; schedules: Schedule[]; webhooks: Webhook[] };

type ArrivedDisabledDto = Omit<ArrivedDisabled, 'schedules' | 'webhooks'> & { schedules: ScheduleDto[]; webhooks: WebhookDto[] };

const toArrived = (dto: ArrivedDisabledDto): ArrivedDisabled => ({
    ...dto,
    schedules: dto.schedules.map(toSchedule),
    webhooks: dto.webhooks.map(toWebhook),
});

export const arrivedCount = (items: ArrivedDisabled[]) => items.reduce((n, item) => n + item.schedules.length + item.webhooks.length, 0);

export const TRIGGERS_SWITCHED = 'flowtinus:triggers-switched';

export async function listArrivedDisabled(ws: string) {
    const result = await api<{ items: ArrivedDisabledDto[] }>(`/w/${ws}/git/arrived-disabled`);
    return result.ok ? { ok: true as const, value: result.value.items.map(toArrived) } : result;
}

export async function commitChanges(ws: string, paths: string[], message: string) {
    const result = await api<{ commit: string; arrived: ArrivedDisabledDto[] }>(`/w/${ws}/git/commit`, {
        method: 'POST',
        body: { paths, message },
    });
    return result.ok ? { ok: true as const, value: { commit: result.value.commit, arrived: result.value.arrived.map(toArrived) } } : result;
}

export const discardChanges = (ws: string, which: { paths: string[] } | { mine: true }) =>
    api<{ discarded: string[] }>(`/w/${ws}/git/discard`, { method: 'POST', body: which });

export type ConflictHunk = { mine: string[]; base: string[]; theirs: string[] };

export type ConflictSegment = { lines: string[] } | { hunk: ConflictHunk };

export type ConflictCase =
    | { type: 'content'; segments: ConflictSegment[]; names?: { mine: string; theirs: string } }
    | { type: 'deleted'; deletedBy: 'mine' | 'theirs'; text: string }
    | { type: 'added'; name: string; mine: string; theirs: string };

export type ConflictView = {
    path: string;
    from?: string;
    kind: string;
    fileId: string | null;
    commit: string;
    revision: number;
    conflict: ConflictCase;
    duplicable: boolean;
};

export type HunkChoice = 'mine' | 'theirs' | 'both' | { edit: string };

export type ConflictResolution = { hunks?: HunkChoice[]; name?: 'mine' | 'theirs'; keep?: boolean; rename?: string };

export const getConflict = (ws: string, path: string) => api<ConflictView>(`/w/${ws}/git/conflict?path=${encodeURIComponent(path)}`);

export const resolveConflict = (ws: string, path: string, revision: number, resolution: ConflictResolution) =>
    api<{ path: string }>(`/w/${ws}/git/conflict`, { method: 'POST', body: { path, revision, ...resolution } });

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
