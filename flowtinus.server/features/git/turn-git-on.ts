import { repoEntry, repoPath, type TreeIssue } from '@flowtinus/core';
import { workspaceSlug } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { gitAuthorOf, readGitState, saveGitConfig, type GitConfig } from './git-config';
import { lockGitCommits, queueGitCommit, type GitChanges } from './git-commits';
import type { GitRemote } from './git-remote';
import { CONFIG_BRANCH } from './topology';
import { exportWorkspace, repoChanges, type RepoFiles } from './workspace-export';
import { draftClashes, holdsWorkspace, ImportConflict, importWorkspace, isWorkspaceEmpty, readBranchWorkspace, validateImport } from './workspace-import';
import { readTopology } from './workspace-topology';

export type FileChange = { path: string; change: 'added' | 'changed' | 'removed'; note?: string };

export type TurnOnCase = 'export' | 'import' | 'choice';

export type TurnOnPlan = {
    branch: string;
    branchExists: boolean;
    case: TurnOnCase;
    toGit: FileChange[];
    toServer: FileChange[];
    errors: TreeIssue[];
    warnings: TreeIssue[];
};

export type TurnOnChoice = 'git' | 'server';

export type TurnOnOutcome = 'exported' | 'imported' | 'server-replaced-git' | 'git-replaced-server';

async function environmentBranch(remote: GitRemote, environment: string): Promise<UseCaseResult<{ branch: string; tip: string | null }>> {
    const branches = await remote.branches();
    const topology = await readTopology(remote, environment, branches);
    if (!topology.exists) {
        return fail('conflict', `The repository has no ${CONFIG_BRANCH} branch.`);
    }
    if (!topology.environment) {
        return fail('conflict', `${environment} is not in the topology.`);
    }

    const branch = topology.environment.branch;
    return success({ branch, tip: await remote.fetch(branch, branches) });
}

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

const inFolder = (files: RepoFiles, slug: string): RepoFiles =>
    Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(`${slug}/`)));

export async function turnOnPlan(ctx: UseCaseContext, remote: GitRemote, config: GitConfig): Promise<UseCaseResult<TurnOnPlan>> {
    const target = await environmentBranch(remote, config.environment);
    if (!target.ok) {
        return target;
    }

    const { branch, tip } = target.value;
    const slug = await workspaceSlug(ctx);
    const onBranch = tip ? await readBranchWorkspace(remote, tip, slug) : {};
    const exported = await exportWorkspace(ctx.db, ctx.workspaceId);
    const holds = holdsWorkspace(onBranch, slug);
    const empty = await isWorkspaceEmpty(ctx.db, ctx.workspaceId);
    const serverSide = inFolder(exported, slug);
    const checked = holds ? await validateImport(ctx.db, ctx.workspaceId, slug, onBranch) : { errors: [], warnings: [] };
    const clashes = holds ? await draftClashes(ctx.db, ctx.workspaceId, slug, onBranch) : [];
    return success({
        branch,
        branchExists: tip !== null,
        case: !holds ? 'export' : empty ? 'import' : 'choice',
        toGit: holds && empty ? [] : fileChanges(onBranch, branchChanges(onBranch, exported)),
        toServer: holds ? serverChanges(serverSide, repoChanges(serverSide, inFormat(inFolder(onBranch, slug)))) : [],
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

    const slug = await workspaceSlug(ctx);
    const onBranch = await readBranchWorkspace(remote, tip, slug);
    try {
        return await ctx.db.transaction(tx => turnOnInTransaction({ ...ctx, db: tx }, input, branch, slug, onBranch));
    } catch (e) {
        if (e instanceof ImportConflict) {
            return fail('conflict', e.message);
        }
        throw e;
    }
}

async function turnOnInTransaction(
    ctx: UseCaseContext,
    input: { choice?: TurnOnChoice },
    branch: string,
    slug: string,
    onBranch: RepoFiles,
): Promise<UseCaseResult<{ outcome: TurnOnOutcome; branch: string; warnings: TreeIssue[] }>> {
    await lockGitCommits(ctx.db, ctx.workspaceId);
    const state = await readGitState(ctx.db, ctx.workspaceId);
    if (!state) {
        return fail('conflict', 'This workspace has no git configuration.');
    }
    if (state.on) {
        return fail('conflict', 'Git is already on.');
    }

    const holds = holdsWorkspace(onBranch, slug);
    const empty = await isWorkspaceEmpty(ctx.db, ctx.workspaceId);
    let outcome: TurnOnOutcome;
    let message: string;
    let warnings: TreeIssue[] = [];
    if (!holds || (!empty && input.choice === 'server')) {
        outcome = holds ? 'server-replaced-git' : 'exported';
        message = holds ? `${state.config.environment} replaces ${slug} in git` : `First export of ${slug}`;
    } else {
        if (!empty && input.choice !== 'git') {
            return fail(
                'conflict',
                `Both ${branch} and this server have the workspace ${slug}: choose whether git replaces the server or the server replaces git.`,
            );
        }

        const validation = await validateImport(ctx.db, ctx.workspaceId, slug, onBranch);
        if (validation.errors.length > 0) {
            const fields: Record<string, string> = {};
            for (const { path, message } of validation.errors) {
                fields[path] = fields[path] ? `${fields[path]}\n${message}` : message;
            }
            return fail('validation', `The workspace on ${branch} is not valid: nothing was ${empty ? 'imported' : 'replaced'}.`, fields);
        }

        await importWorkspace(ctx, slug, onBranch);
        outcome = empty ? 'imported' : 'git-replaced-server';
        message = `Canonical form of ${slug}`;
        warnings = validation.warnings;
    }

    await saveGitConfig(ctx, state.config, true);
    const changes = branchChanges(onBranch, await exportWorkspace(ctx.db, ctx.workspaceId));
    if (Object.keys(changes).length > 0) {
        await queueGitCommit(ctx, { message, changes: async () => changes });
    }

    return success({ outcome, branch, warnings });
}
