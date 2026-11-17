import { repoPath, type TreeIssue } from '@flowtinus/core';
import { workspaceSlug } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { gitAuthorOf, readGitState, saveGitConfig, type GitConfig } from './git-config';
import { lockGitCommits, queueGitCommit, type GitChanges } from './git-commits';
import type { GitRemote } from './git-remote';
import { CONFIG_BRANCH } from './topology';
import { exportWorkspace, repoChanges, type RepoFiles } from './workspace-export';
import { holdsWorkspace, ImportConflict, importWorkspace, isWorkspaceEmpty, readBranchWorkspace, validateImport } from './workspace-import';
import { readTopology } from './workspace-topology';

export type FileChange = { path: string; change: 'added' | 'changed' | 'removed' };

/** export: the branch has no workspace; import: this server's workspace is empty; choice: both have one */
export type TurnOnCase = 'export' | 'import' | 'choice';

export type TurnOnPlan = {
    branch: string;
    branchExists: boolean;
    case: TurnOnCase;
    /** what the server's side writes on the branch: the first export, or "the server replaces git" */
    toGit: FileChange[];
    /** what git's side changes in what this server holds: the import, or "git replaces the server" */
    toServer: FileChange[];
    /** the branch's workspace checked as an import checks it */
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

/** what makes the branch hold the workspace as exported; a .gitattributes the branch already has is left as it is */
function branchChanges(onBranch: RepoFiles, exported: RepoFiles): GitChanges {
    const changes = repoChanges(onBranch, exported);
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

const inFolder = (files: RepoFiles, slug: string): RepoFiles =>
    Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(`${slug}/`)));

/** what turning git on would do, changing nothing */
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
    return success({
        branch,
        branchExists: tip !== null,
        case: !holds ? 'export' : empty ? 'import' : 'choice',
        toGit: holds && empty ? [] : fileChanges(onBranch, branchChanges(onBranch, exported)),
        toServer: holds ? fileChanges(serverSide, repoChanges(serverSide, inFolder(onBranch, slug))) : [],
        ...(holds ? await validateImport(ctx.db, ctx.workspaceId, slug, onBranch) : { errors: [], warnings: [] }),
    });
}

/**
 * git on, by the case: the first export, the import, or the side the admin chose replacing the other. A missing branch is
 * created, empty, only with createBranch. What git's side brings is committed back in its canonical form when the branch
 * holds it otherwise, so that the branch is what the server exports. Drafts stay as they are.
 */
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
