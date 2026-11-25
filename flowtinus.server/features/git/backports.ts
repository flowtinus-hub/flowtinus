import { z } from 'zod';
import type { TreeIssue } from '@flowtinus/core';
import { workspaceHandle } from '#features/folders/project-tree';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { lockBranch, noteHead } from './branch-write';
import { backportBranch, shortSha } from './current-branch';
import { targetAhead } from './environments';
import { gitAuthorOf, type GitConfig, type GitOptions } from './git-config';
import { onWorkspaceRepository } from './git-handlers';
import type { GitRemote } from './git-remote';
import { holdMerge, inScope, pendingMerge } from './pending-merge';
import { arrivalWarnings, edgeLinks, edgeOut, fetchAndFollow, gitOff, invalidMerge, openAlong, type Edge, type PreflightWarning } from './promotion-edge';
import { promotionRows, toPromotion, type Promotion } from './promotion-state';
import { providerOf, type Provider } from './pull-request';
import { hasWorkingCopy } from './working-copy';
import { readBranchWorkspace } from './workspace-import';

export type BackportBlock = { kind: 'no-branch' | 'not-ahead' | 'outside' | 'invalid'; message: string; issues?: TreeIssue[] };

/** sha: the target's tip, the only commit a backport takes; conflicts: left as a pending merge, they do not block */
export type BackportPreflight = {
    sha: string | null;
    branch: string | null;
    conflicts: string[];
    blocks: BackportBlock[];
    warnings: PreflightWarning[];
    open: Promotion[];
};

type Checked = Omit<BackportPreflight, 'open'> & { tree: string | null };

// the edge leaves this server (S → E): the backport runs against it, E's tip merged into S's branch
async function runBackportPreflight(ctx: UseCaseContext, remote: GitRemote, edge: Edge): Promise<Checked> {
    const nothing = { conflicts: [], warnings: [], tree: null };
    if (!edge.sourceTip || !edge.targetTip) {
        const missing = edge.sourceTip ? edge.target.branch : edge.source.branch;
        return { sha: null, branch: null, ...nothing, blocks: [{ kind: 'no-branch', message: `The branch ${missing} does not exist.` }] };
    }
    const sha = edge.targetTip;
    const branch = backportBranch(edge.target.env, sha);
    if (!(await targetAhead(remote, edge.sourceTip, sha))) {
        const message = `${edge.target.env} is not ahead of ${edge.source.env}: there is nothing to backport.`;
        return { sha, branch, ...nothing, blocks: [{ kind: 'not-ahead', message }] };
    }

    const handle = await workspaceHandle(ctx);
    const merged = await remote.mergeTree(edge.sourceTip, sha);
    const [before, after] = await Promise.all([
        readBranchWorkspace(remote, edge.sourceTip, handle),
        readBranchWorkspace(remote, merged.tree, handle),
    ]);
    const blocks: BackportBlock[] = [];
    const outside = merged.conflicts.filter(path => !inScope(path, handle));
    if (outside.length > 0) {
        blocks.push({
            kind: 'outside',
            message: `Merging ${edge.target.branch} into ${edge.source.branch} conflicts outside this workspace (${outside.join(', ')}): backport it in git.`,
        });
    }
    const invalid = merged.conflicts.length === 0 ? invalidMerge(handle, after, edge.source.env) : null;
    if (invalid) {
        blocks.push(invalid);
    }

    const warnings = arrivalWarnings(handle, before, after, edge.source.env);
    return { sha, branch, conflicts: merged.conflicts, blocks, warnings, tree: merged.tree };
}

async function preflightOf(ctx: UseCaseContext, remote: GitRemote, config: GitConfig, edge: Edge) {
    const { tree, ...checked } = await runBackportPreflight(ctx, remote, edge);
    const open = await openAlong(ctx, config, edge, { kind: 'backport', source: edge.target.env, target: edge.source.env });
    return { checked: { ...checked, open }, tree };
}

const BackportInput = z.object({ target: z.string().min(1, 'The environment ahead') });

export class GetBackportPreflightHandler implements UseCaseHandler<BackportPreflight> {
    constructor(private readonly options: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<BackportPreflight>> {
        const denied = requireRole(ctx, 'viewer') ?? (await gitOff(ctx));
        if (denied) {
            return denied;
        }
        const parsed = validate(BackportInput, input);
        if (!parsed.ok) {
            return parsed;
        }

        return onWorkspaceRepository(ctx, this.options, async (remote, config) => {
            const edge = await edgeOut(remote, config.environment, parsed.value.target);
            return edge.ok ? success((await preflightOf(ctx, remote, config, edge.value)).checked) : edge;
        });
    }
}

/** reused: the open backport of the same tip; conflicts: the files its pending merge waits on */
export type OpenedBackport = {
    promotion: Promotion;
    reused: boolean;
    alsoOpen: Promotion[];
    conflicts: string[];
    provider: Provider | null;
};

export class OpenBackportHandler implements UseCaseHandler<OpenedBackport> {
    constructor(private readonly options: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<OpenedBackport>> {
        const denied = requireRole(ctx, 'admin') ?? (await gitOff(ctx));
        if (denied) {
            return denied;
        }
        const parsed = validate(BackportInput, input);
        if (!parsed.ok) {
            return parsed;
        }

        return onWorkspaceRepository(ctx, this.options, async (remote, config): Promise<UseCaseResult<OpenedBackport>> => {
            const heads = await fetchAndFollow(ctx, remote, config);
            const edge = await edgeOut(remote, config.environment, parsed.value.target, heads);
            if (!edge.ok) {
                return edge;
            }
            const { checked, tree } = await preflightOf(ctx, remote, config, edge.value);
            const { sha, branch, conflicts, blocks, open } = checked;
            const provider = await providerOf(config.repository);
            const same = open.find(p => p.sha === sha);
            if (same) {
                const waiting = await pendingMerge(ctx.db, ctx.workspaceId, same.branch);
                const alsoOpen = open.filter(p => p !== same);
                return success({ promotion: same, reused: true, alsoOpen, conflicts: waiting?.conflicts ?? [], provider });
            }
            if (blocks.length > 0 || !sha || !branch || !tree) {
                return fail('conflict', blocks.map(b => b.message).join(' '));
            }
            if (heads.has(branch)) {
                return fail('conflict', `The branch ${branch} is in the repository: delete it, then backport again.`);
            }
            if ((await hasWorkingCopy(ctx.db, ctx.workspaceId, branch)) || (await pendingMerge(ctx.db, ctx.workspaceId, branch))) {
                return fail('conflict', `The branch ${branch} still has changes on this server: discard them, then backport again.`);
            }

            const source = edge.value.source;
            const target = edge.value.target;
            const ours = edge.value.sourceTip!;
            if (conflicts.length === 0) {
                const commit = await remote.commit({
                    parent: ours,
                    changes: {},
                    message: `Backport ${target.env}: merge ${target.branch} at ${shortSha(sha)} into ${source.branch}`,
                    author: await gitAuthorOf(ctx),
                    merge: { tree, theirs: sha },
                });
                await remote.push(commit, branch, null);
                await noteHead(ctx.db, ctx.workspaceId, ctx.userId, branch, commit);
            } else {
                const base = await remote.mergeBase(ours, sha);
                if (!base) {
                    return fail('conflict', `${source.branch} and ${target.branch} have no commit in common: backport in git.`);
                }
                const handle = await workspaceHandle(ctx);
                const tipFiles = await readBranchWorkspace(remote, ours, handle);
                await remote.push(ours, branch, null);
                await noteHead(ctx.db, ctx.workspaceId, ctx.userId, branch, ours);
                await ctx.db.transaction(async db => {
                    await lockBranch(db, ctx.workspaceId, branch);
                    await holdMerge(db, ctx, remote, {
                        branch,
                        handle,
                        ours,
                        theirs: sha,
                        base,
                        environment: target.branch,
                        tipFiles,
                        tree,
                        conflicts,
                    });
                });
            }

            const id = crypto.randomUUID();
            await ctx.db.query(
                `INSERT INTO promotions (id, workspace_id, kind, source, target, sha, branch, opened_by, state)
                 VALUES ($1, $2, 'backport', $3, $4, $5, $6, $7, 'open')`,
                [id, ctx.workspaceId, target.env, source.env, sha, branch, ctx.userId],
            );
            const [row] = await promotionRows(ctx, { id });
            return success({
                promotion: toPromotion(row!, edgeLinks(edge.value, config, provider)),
                reused: false,
                alsoOpen: open,
                conflicts,
                provider,
            });
        });
    }
}
