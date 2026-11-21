import { repoEntry, repoPath, type TreeIssue, type TriggerKind } from '@flowtinus/core';
import { workspaceHandle } from '#features/folders/project-tree';
import { draftsTakeEnvironmentTriggers } from '#features/flows/flow-draft';
import { foldOverrides } from '#features/schedules/schedules';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { gitAuthorOf, readGitState, saveGitConfig, type GitConfig } from './git-config';
import { commitFirst } from './git-first';
import { GitError, type GitRemote } from './git-remote';
import { applyCommit, lockReconcile } from './reconcile';
import { exportTree, exportWorkspace, repoChanges, type GitChanges, type RepoFiles } from './workspace-export';
import { draftClashes, holdsWorkspace, ImportConflict, importWorkspace, isWorkspaceEmpty, issueFields, readBranchWorkspace, triggerIdsOf, validateImport } from './workspace-import';
import { environmentBranch } from './workspace-topology';
import { fetchAndReconcile } from './git-heads';

export type FileChange = { path: string; change: 'added' | 'changed' | 'removed'; note?: string };

export type TurnOnCase = 'export' | 'import' | 'choice';

export type TurnOnPlan = {
    branch: string;
    branchExists: boolean;
    case: TurnOnCase;
    toGit: FileChange[];
    toServer: FileChange[];
    triggersToServer: TriggerChange[];
    errors: TreeIssue[];
    warnings: TreeIssue[];
};

export type TriggerChange = { kind: TriggerKind; id: string; path: string; change: 'kept' | 'arrives-disabled' | 'archived' };

export type TurnOnChoice = 'git' | 'server';

export type TurnOnOutcome = 'exported' | 'imported' | 'server-replaced-git' | 'git-replaced-server';

const inFormat = (files: RepoFiles): RepoFiles =>
    Object.fromEntries(Object.entries(files).filter(([path]) => repoEntry(path).kind !== 'unknown'));

function branchChanges(onBranch: RepoFiles, exported: RepoFiles): GitChanges {
    const changes = repoChanges(inFormat(onBranch), exported);
    if (repoPath.gitattributes in onBranch) {
        delete changes[repoPath.gitattributes];
    }
    return changes;
}

function fileChanges(before: RepoFiles, changes: GitChanges): FileChange[] {
    return Object.entries(changes)
        .map(([path, content]): FileChange => ({ path, change: content === null ? 'removed' : path in before ? 'changed' : 'added' }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function serverChanges(before: RepoFiles, changes: GitChanges): FileChange[] {
    return fileChanges(before, changes).map(change => {
        const entry = repoEntry(change.path);
        if (change.change !== 'removed' || entry.kind !== 'connection') {
            return change;
        }

        const note = `The connection ${entry.name} is deleted from this server, with its configuration and credentials (the secrets it names stay).`;
        return { ...change, note };
    });
}

async function triggerChanges(
    ctx: UseCaseContext,
    handle: string,
    onBranch: RepoFiles,
    pathOf: Map<string, string>,
): Promise<TriggerChange[]> {
    const here = await ctx.db.query<{ kind: TriggerKind; id: string; flow_id: string; flow_name: string }>(
        `SELECT 'schedule' AS kind, s.id, s.flow_id, f.name AS flow_name FROM flow_schedules s JOIN flows f ON f.id = s.flow_id
      WHERE s.workspace_id = $1 AND s.archived_at IS NULL
     UNION ALL SELECT 'webhook', w.id, w.flow_id, f.name FROM flow_webhooks w JOIN flows f ON f.id = w.flow_id
      WHERE w.workspace_id = $1 AND w.archived_at IS NULL`,
        [ctx.workspaceId],
    );
    const inGit = triggerIdsOf(onBranch, handle);
    const kept = new Set(here.map(t => t.id));
    const stays = new Set(inGit.map(t => t.id));
    const changes: TriggerChange[] = [
        ...inGit.map(({ kind, id, path }): TriggerChange => ({ kind, id, path, change: kept.has(id) ? 'kept' : 'arrives-disabled' })),
        ...here
            .filter(t => !stays.has(t.id))
            .map(({ kind, id, flow_id, flow_name }): TriggerChange => ({
                kind,
                id,
                path: pathOf.get(flow_id) ?? flow_name,
                change: 'archived',
            })),
    ];
    return changes.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

const inFolder = (files: RepoFiles, handle: string): RepoFiles =>
    Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(`${handle}/`)));

export async function turnOnPlan(ctx: UseCaseContext, remote: GitRemote, config: GitConfig): Promise<UseCaseResult<TurnOnPlan>> {
    const target = await environmentBranch(remote, config.environment);
    if (!target.ok) {
        return target;
    }

    const { branch, tip } = target.value;
    const handle = await workspaceHandle(ctx);
    const onBranch = tip ? await readBranchWorkspace(remote, tip, handle) : {};
    const { files: exported, ids } = await exportTree(ctx.db, ctx.workspaceId, 'committed');
    const holds = holdsWorkspace(onBranch, handle);
    const empty = await isWorkspaceEmpty(ctx.db, ctx.workspaceId);
    const serverSide = inFolder(exported, handle);
    const checked = holds ? await validateImport(ctx.db, ctx.workspaceId, handle, onBranch) : { errors: [], warnings: [] };
    const clashes = holds ? await draftClashes(ctx.db, ctx.workspaceId, handle, onBranch) : [];
    return success({
        branch,
        branchExists: tip !== null,
        case: !holds ? 'export' : empty ? 'import' : 'choice',
        toGit: holds && empty ? [] : fileChanges(onBranch, branchChanges(onBranch, exported)),
        toServer: holds ? serverChanges(serverSide, repoChanges(serverSide, inFormat(inFolder(onBranch, handle)))) : [],
        triggersToServer: holds
            ? await triggerChanges(ctx, handle, onBranch, new Map(Object.entries(ids).map(([path, id]) => [id, path])))
            : [],
        errors: [...checked.errors, ...clashes],
        warnings: checked.warnings,
    });
}

export async function turnGitOn(
    ctx: UseCaseContext,
    remote: GitRemote,
    config: GitConfig,
    input: { createBranch?: boolean; choice?: TurnOnChoice },
): Promise<UseCaseResult<{ outcome: TurnOnOutcome; branch: string; warnings: TreeIssue[] }>> {
    if ((await readGitState(ctx.db, ctx.workspaceId))?.on) {
        return fail('conflict', 'Git is already on.');
    }

    const target = await environmentBranch(remote, config.environment);
    if (!target.ok) {
        return target;
    }

    const { branch } = target.value;
    let tip = target.value.tip;
    if (!tip) {
        if (!input.createBranch) {
            return fail('conflict', `The branch ${branch} does not exist: confirm creating it.`);
        }

        tip = await remote.commit({ parent: null, changes: {}, message: `Create ${branch}`, author: await gitAuthorOf(ctx) });
        await remote.push(tip, branch, null);
    }

    const handle = await workspaceHandle(ctx);
    const onBranch = await readBranchWorkspace(remote, tip, handle);
    try {
        const turned = await ctx.db.transaction(tx =>
            turnOnInTransaction({ ...ctx, db: tx }, remote, input, { branch, tip: tip!, handle, onBranch }),
        );
        if (turned.ok) {
            await showWorkBranches(ctx, remote, config);
        }
        return turned;
    } catch (e) {
        if (e instanceof ImportConflict) {
            return fail('conflict', e.message);
        }
        if (e instanceof UseCaseFailure) {
            return { ok: false, error: e.error };
        }
        if (e instanceof GitError) {
            return fail('unavailable', `Git could not be reached, git stays off: ${e.message}`);
        }
        throw e;
    }
}

async function turnOnInTransaction(
    ctx: UseCaseContext,
    remote: GitRemote,
    input: { choice?: TurnOnChoice },
    { branch, tip, handle, onBranch }: { branch: string; tip: string; handle: string; onBranch: RepoFiles },
): Promise<UseCaseResult<{ outcome: TurnOnOutcome; branch: string; warnings: TreeIssue[] }>> {
    await lockReconcile(ctx.db, ctx.workspaceId);
    const state = await readGitState(ctx.db, ctx.workspaceId);
    if (!state) {
        return fail('conflict', 'This workspace has no git configuration.');
    }
    if (state.on) {
        return fail('conflict', 'Git is already on.');
    }

    const holds = holdsWorkspace(onBranch, handle);
    const empty = await isWorkspaceEmpty(ctx.db, ctx.workspaceId);
    let outcome: TurnOnOutcome;
    let message: string;
    let warnings: TreeIssue[] = [];
    if (!holds || (!empty && input.choice === 'server')) {
        outcome = holds ? 'server-replaced-git' : 'exported';
        message = holds ? `${state.config.environment} replaces ${handle} in git` : `First export of ${handle}`;
        await foldOverrides(ctx.db, ctx.workspaceId);
    } else {
        if (!empty && input.choice !== 'git') {
            return fail(
                'conflict',
                `Both ${branch} and this server have the workspace ${handle}: choose whether git replaces the server or the server replaces git.`,
            );
        }

        const validation = await validateImport(ctx.db, ctx.workspaceId, handle, onBranch);
        if (validation.errors.length > 0) {
            return fail(
                'validation',
                `The workspace on ${branch} is not valid: nothing was ${empty ? 'imported' : 'replaced'}.`,
                issueFields(validation.errors),
            );
        }

        await foldOverrides(ctx.db, ctx.workspaceId);
        await importWorkspace(ctx, handle, onBranch);
        outcome = empty ? 'imported' : 'git-replaced-server';
        message = `Canonical form of ${handle}`;
        warnings = validation.warnings;
    }

    await draftsTakeEnvironmentTriggers(ctx.db, ctx.workspaceId);
    await saveGitConfig(ctx, state.config, true);
    const changes = branchChanges(onBranch, await exportWorkspace(ctx.db, ctx.workspaceId, 'committed'));
    if (Object.keys(changes).length > 0) {
        await commitFirst(ctx, state.config, remote, message, changes);
    } else {
        await applyCommit(ctx, remote, { branch, commit: tip }, handle, onBranch, warnings);
    }

    return success({ outcome, branch, warnings });
}

async function showWorkBranches(ctx: UseCaseContext, remote: GitRemote, config: GitConfig): Promise<void> {
    try {
        await fetchAndReconcile(ctx, remote, config);
    } catch (e) {
        // git is on already: the next poll records the heads (until then a work branch answers "pick another branch")
        if (!(e instanceof GitError)) {
            throw e;
        }
    }
}
