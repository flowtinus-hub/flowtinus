import { z } from 'zod';
import { repoFlowFromYaml, repoFlowToYaml, slugOf, type FlowFile } from '@flowtinus/core';
import { adapterOf } from '#features/git/adapter-status';
import { onClone } from '#features/git/branch-read';
import { noteHead } from '#features/git/branch-write';
import { HOTFIX_PREFIX } from '#features/git/current-branch';
import { gitAuthorOf, gitBranch, readGitConfig } from '#features/git/git-config';
import type { GitRemote } from '#features/git/git-remote';
import { mergeRequestDescription, openMergeRequest, pullRequestUrl, workBranchRequest, type OpenedMergeRequest } from '#features/git/merge-request';
import { fileChanges, flowImpact } from '#features/git/promotions';
import { providerOf, pullRequestLink, type Provider } from '#features/git/pull-request';
import { idOfFile } from '#features/git/working-copy';
import type { RepoFiles } from '#features/git/workspace-export';
import { issueFields, readBranchWorkspace, validateImport } from '#features/git/workspace-import';
import { environmentBranch } from '#features/git/workspace-topology';
import type { Flow } from '#features/flows/flow';
import { flowRepoPath } from '#features/flows/flow-draft';
import { workspaceHandle } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { commitDeploy, type CommittedDeployments } from '../commit-deploy';
import { activeFlow, contentHash, emergencyRollbackOf, loadDeployments } from '../deployments';

export const MakeGitMatchCommand = z.object({ id: z.uuid('Invalid') });

/** the branch the fix was pushed to, in the modes with a review; reused: it was there already, with the content that runs */
export type RollbackFix = {
    branch: string;
    target: string;
    reused: boolean;
    provider: Provider | null;
    url: string | null;
} & OpenedMergeRequest;

export type MadeGitMatch = CommittedDeployments & { fix?: RollbackFix };

// the slug can be empty (a name with no latin letter or digit): the flow's short id still tells the branch apart
export const rollbackBranch = (flow: Pick<Flow, 'id' | 'name'>, number: number) =>
    ['rollback', slugOf(flow.name), flow.id.slice(0, 8), `v${number}`].filter(Boolean).join('-');

type RolledBack = { number: number; definition: FlowFile; hash: string };

function flowIn(files: RepoFiles, flowId: string): { path: string; text: string } | null {
    const path = Object.keys(files).find(p => idOfFile(p, files[p]!) === flowId);
    return path ? { path, text: files[path]! } : null;
}

/**
 * "Make git match what runs": a commit of the rolled-back version's content of the flow, alone. In direct it goes on the
 * environment's branch; with a review, through a shared work branch (pull-request) or a hotfix (protected), cut from the
 * tip, and its pull request. Applied, it ends the rollback with the same content running, under a new version.
 */
export class MakeGitMatchHandler implements UseCaseHandler<MadeGitMatch> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<MadeGitMatch>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(MakeGitMatchCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        const git = await gitBranch(ctx.db, ctx.workspaceId);
        if (!git) {
            return fail('conflict', 'Git is off in this workspace.');
        }
        const flow = await activeFlow(ctx, parsed.value.id);
        if (!flow) {
            return fail('not-found', 'Flow not found.');
        }
        const rollback = await emergencyRollbackOf(ctx.db, ctx.workspaceId, flow.id);
        if (!rollback) {
            return fail('conflict', `${flow.name} is not in an emergency rollback.`);
        }
        const [version] = await ctx.db.query<{ definition: FlowFile; content_hash: string }>(
            'SELECT definition, content_hash FROM flow_versions WHERE id = $1',
            [rollback.versionId],
        );
        const rolledBack: RolledBack = { number: rollback.number, definition: version!.definition, hash: version!.content_hash };
        const message = `Make git match what runs: ${flow.name} v${rolledBack.number}`;

        if (git.mode === 'direct') {
            return commitDeploy(ctx, flow, message, async db => {
                // a commit of git's applied before this one may have ended the rollback, or a colleague changed it
                if ((await emergencyRollbackOf(db, ctx.workspaceId, flow.id))?.versionId !== rollback.versionId) {
                    return {
                        code: 'conflict',
                        message: `The emergency rollback of ${flow.name} changed meanwhile: nothing was committed.`,
                    };
                }
                return { definition: rolledBack.definition, deployed: true };
            });
        }

        const fix = await pushFix(
            ctx,
            flow,
            rolledBack,
            `${git.mode === 'protected' ? HOTFIX_PREFIX : ''}${rollbackBranch(flow, rolledBack.number)}`,
            message,
        );
        return fix.ok ? success({ ...(await loadDeployments(ctx.db, ctx.workspaceId, flow.id)), fix: fix.value }) : fix;
    }
}

async function pushFix(
    ctx: UseCaseContext,
    flow: Flow,
    rolledBack: RolledBack,
    branch: string,
    title: string,
): Promise<UseCaseResult<RollbackFix>> {
    const config = (await readGitConfig(ctx.db, ctx.workspaceId))!;
    const handle = await workspaceHandle(ctx);
    const adapter = await adapterOf(ctx, config);

    const pushed = await onClone(ctx, 'Git could not be reached, nothing was pushed', async remote => {
        const branches = await remote.branches();
        const environment = await environmentBranch(remote, config.environment, branches);
        if (!environment.ok) {
            return environment;
        }
        const { branch: target, tip: base } = environment.value;
        if (!base) {
            return fail('conflict', `The branch ${target} is not in the repository.`);
        }

        const existing = branches.has(branch) ? await remote.fetch(branch, branches) : null;
        const fixed = existing
            ? await reuse(remote, flow, rolledBack, branch, existing, handle)
            : await commitFix(ctx, remote, flow, rolledBack, { branch, base, handle, message: title });
        if (!fixed.ok) {
            return fixed;
        }
        const description = adapter ? await describe(ctx, remote, base, fixed.value, handle) : '';
        return success({ target, tip: fixed.value, reused: !!existing, description });
    });
    if (!pushed.ok) {
        return pushed;
    }

    const { target, reused, description } = pushed.value;
    const provider = await providerOf(config.repository);
    const opened = await openMergeRequest(adapter, workBranchRequest({ source: branch, target, title, description }));
    const link = provider ? pullRequestLink(config.repository, provider, branch, target) : null;
    return success({ branch, target, reused, provider, url: pullRequestUrl(opened, link), ...opened });
}

// shared, so a colleague may have changed it: it is the fix only while its flow is still what runs
async function reuse(
    remote: GitRemote,
    flow: Flow,
    rolledBack: RolledBack,
    branch: string,
    tip: string,
    handle: string,
): Promise<UseCaseResult<string>> {
    const found = flowIn(await readBranchWorkspace(remote, tip, handle), flow.id);
    const read = found ? repoFlowFromYaml(found.text, flow.name) : null;
    if (!read?.ok || contentHash(read.value.flow) !== rolledBack.hash) {
        return fail(
            'conflict',
            `The branch ${branch} exists, and its ${flow.name} is not the version that runs (v${rolledBack.number}): delete the branch, or merge it as it is.`,
        );
    }
    return success(tip);
}

async function commitFix(
    ctx: UseCaseContext,
    remote: GitRemote,
    flow: Flow,
    rolledBack: RolledBack,
    { branch, base, handle, message }: { branch: string; base: string; handle: string; message: string },
): Promise<UseCaseResult<string>> {
    const found = flowIn(await readBranchWorkspace(remote, base, handle), flow.id);
    const path = found?.path ?? (await flowRepoPath(ctx.db, ctx.workspaceId, flow));
    const inTip = found ? repoFlowFromYaml(found.text, flow.name) : null;
    const triggers = inTip?.ok ? inTip.value : {};
    const commit = await remote.commit({
        parent: base,
        changes: { [path]: repoFlowToYaml({ ...rolledBack.definition, id: flow.id }, { ...triggers, deployed: true }) },
        message,
        author: await gitAuthorOf(ctx),
    });
    const { errors } = await validateImport(ctx.db, ctx.workspaceId, handle, await readBranchWorkspace(remote, commit, handle));
    if (errors.length > 0) {
        return fail('validation', `The branch ${branch} would not be valid: nothing was pushed.`, issueFields(errors));
    }
    await remote.push(commit, branch, null);
    await noteHead(ctx.db, ctx.workspaceId, ctx.userId, branch, commit);
    return success(commit);
}

async function describe(ctx: UseCaseContext, remote: GitRemote, base: string, tip: string, handle: string): Promise<string> {
    const [before, after] = await Promise.all([readBranchWorkspace(remote, base, handle), readBranchWorkspace(remote, tip, handle)]);
    return mergeRequestDescription(ctx, {
        notes: ['The fix of an emergency rollback: git takes the version of the flow that runs.'],
        files: await fileChanges(remote, base, tip),
        flows: flowImpact(before, after, handle),
    });
}
