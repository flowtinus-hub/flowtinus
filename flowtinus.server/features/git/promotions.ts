import { z } from 'zod';
import type { TreeIssue } from '@flowtinus/core';
import { workspaceHandle } from '#features/folders/project-tree';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { flowsIn, targetAhead } from './environments';
import { shortSha } from './current-branch';
import { gitAuthorOf, type GitConfig, type GitOptions } from './git-config';
import { onWorkspaceRepository } from './git-handlers';
import type { GitRemote } from './git-remote';
import { providerOf, pullRequestLink, type Provider } from './pull-request';
import { arrivalWarnings, edgeLinks, edgeOut, fetchAndFollow, gitOff, invalidMerge, openAlong, plural, type Edge, type PreflightWarning } from './promotion-edge';
import { promotionRows, rowEdge, toPromotion, type Promotion } from './promotion-state';
import { isChange, workingRows } from './working-copy';
import { workspaceEntries, type RepoFiles } from './workspace-export';
import { readBranchWorkspace } from './workspace-import';

export type GraphCommit = {
    sha: string;
    parents: string[];
    message: string;
    author: string;
    at: string;
    choosable: boolean;
    inTarget: boolean;
};

/** next: the skip of the next page ("load more"), null on the last one, which ends with a few commits already in the target */
export type CommitGraph = {
    source: string;
    target: string;
    sourceTip: string | null;
    targetTip: string | null;
    commits: GraphCommit[];
    next: number | null;
};

export type FileChange = { path: string; status: 'added' | 'modified' | 'deleted' };

export type FlowChange = 'added' | 'removed' | 'renamed' | 'changed' | 'deployed' | 'undeployed';

/** name: in the merge result (in the target for a removed flow); from: its name in the target when renamed */
export type FlowImpact = { id: string; name: string; from?: string; changes: FlowChange[] };

export type ScriptImpact = { path: string; change: 'added' | 'changed' | 'removed' };

export type PreflightBlock = {
    kind: 'no-target' | 'conflicts' | 'ahead' | 'broken' | 'invalid' | 'empty';
    message: string;
    issues?: TreeIssue[];
};

export type Preflight = {
    sha: string;
    branch: string;
    files: FileChange[];
    impact: { flows: FlowImpact[]; scripts: ScriptImpact[] };
    blocks: PreflightBlock[];
    warnings: PreflightWarning[];
    open: Promotion[];
};

const GRAPH_PAGE = 200;
const CONTEXT_COMMITS = 3;

export const promotionBranch = (source: string, sha: string) => `promote/${source}-${shortSha(sha)}`;

export const repairBranch = (target: string, sha: string) => `repair/${target}-${shortSha(sha)}`;

async function onFirstParentLine(remote: GitRemote, sha: string, tip: string): Promise<boolean> {
    if (!/^[0-9a-f]{40}$/.test(sha) || !(await remote.hasCommit(sha)) || !(await remote.isAncestor(sha, tip))) {
        return false;
    }
    if (sha === tip) {
        return true;
    }
    const line = (await remote.run(['rev-list', '--first-parent', '--parents', tip, `^${sha}`])).trim().split('\n');
    return line.at(-1)!.split(' ')[1] === sha;
}

const notOnLine = (sha: string, edge: Edge) =>
    fail(
        'conflict',
        `${sha} is not a commit of ${edge.source.branch}'s first-parent line: only a state ${edge.source.env} was at can be promoted.`,
    );

const FIELD = '%x1f';
const RECORD = '%x1e';

async function logOf(remote: GitRemote, args: string[]): Promise<Omit<GraphCommit, 'choosable' | 'inTarget'>[]> {
    const out = await remote.run(['log', `--format=%H${FIELD}%P${FIELD}%an${FIELD}%aI${FIELD}%s${RECORD}`, ...args]);
    return out
        .split('\x1e')
        .map(record => record.trim())
        .filter(Boolean)
        .map(record => {
            const [sha, parents, author, at, message] = record.split('\x1f') as [string, string, string, string, string];
            return { sha, parents: parents.split(' ').filter(Boolean), author, at: new Date(at).toISOString(), message };
        });
}

async function commitGraph(remote: GitRemote, edge: Edge, skip: number): Promise<CommitGraph> {
    const graph = { source: edge.source.env, target: edge.target.env, sourceTip: edge.sourceTip, targetTip: edge.targetTip };
    if (!edge.sourceTip || !edge.targetTip) {
        return { ...graph, commits: [], next: null };
    }

    const range = [edge.sourceTip, `^${edge.targetTip}`];
    const line = new Set((await remote.run(['rev-list', '--first-parent', ...range])).split('\n').filter(Boolean));
    const page = await logOf(remote, ['--topo-order', `--skip=${skip}`, `--max-count=${GRAPH_PAGE + 1}`, ...range]);
    const more = page.length > GRAPH_PAGE;
    const commits: GraphCommit[] = page.slice(0, GRAPH_PAGE).map(c => ({ ...c, choosable: line.has(c.sha), inTarget: false }));
    if (!more) {
        // the first-parent line is contiguous from the tip: what follows its pending part is already in the target
        const context = await logOf(remote, ['--first-parent', `--skip=${line.size}`, `--max-count=${CONTEXT_COMMITS}`, edge.sourceTip]);
        commits.push(...context.map(c => ({ ...c, choosable: false, inTarget: true })));
    }
    return { ...graph, commits, next: more ? skip + GRAPH_PAGE : null };
}

async function fileChanges(remote: GitRemote, from: string, to: string): Promise<FileChange[]> {
    const parts = (await remote.run(['diff-tree', '-r', '--no-renames', '--name-status', '-z', from, to])).split('\0').filter(Boolean);
    const changes: FileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const status = parts[i] === 'A' ? 'added' : parts[i] === 'D' ? 'deleted' : 'modified';
        changes.push({ path: parts[i + 1]!, status });
    }
    return changes;
}

function flowImpact(before: RepoFiles, after: RepoFiles, handle: string): FlowImpact[] {
    const inTarget = flowsIn(before, handle);
    const inResult = flowsIn(after, handle);
    const impact: FlowImpact[] = [];
    for (const [id, flow] of inResult) {
        const old = inTarget.get(id);
        if (!old) {
            impact.push({ id, name: flow.name, changes: ['added'] });
            continue;
        }
        const changes: FlowChange[] = [];
        if (old.name !== flow.name) {
            changes.push('renamed');
        }
        if (old.hash !== flow.hash) {
            changes.push('changed');
        }
        if (old.deployed !== flow.deployed) {
            changes.push(flow.deployed ? 'deployed' : 'undeployed');
        }
        if (changes.length > 0) {
            impact.push({ id, name: flow.name, ...(old.name !== flow.name ? { from: old.name } : {}), changes });
        }
    }
    for (const [id, flow] of inTarget) {
        if (!inResult.has(id)) {
            impact.push({ id, name: flow.name, changes: ['removed'] });
        }
    }
    return impact.sort((a, b) => a.name.localeCompare(b.name));
}

const scriptsIn = (files: RepoFiles, handle: string) =>
    new Map(workspaceEntries(files, handle, 'script').map(({ entry, text }) => [`${entry.project}/${entry.path}`, text]));

function scriptImpact(before: RepoFiles, after: RepoFiles, handle: string): ScriptImpact[] {
    const inTarget = scriptsIn(before, handle);
    const inResult = scriptsIn(after, handle);
    const impact: ScriptImpact[] = [
        ...[...inResult]
            .filter(([path, text]) => inTarget.get(path) !== text)
            .map(([path]) => ({ path, change: inTarget.has(path) ? 'changed' : 'added' }) as const),
        ...[...inTarget.keys()].filter(path => !inResult.has(path)).map(path => ({ path, change: 'removed' }) as const),
    ];
    return impact.sort((a, b) => a.path.localeCompare(b.path));
}

async function runPreflight(ctx: UseCaseContext, remote: GitRemote, edge: Edge, sha: string): Promise<Omit<Preflight, 'open'>> {
    const branch = promotionBranch(edge.source.env, sha);
    if (!edge.targetTip || !edge.sourceTip) {
        const message = `The branch ${edge.target.branch} does not exist: turning git on in ${edge.target.env} creates it.`;
        return { sha, branch, files: [], impact: { flows: [], scripts: [] }, warnings: [], blocks: [{ kind: 'no-target', message }] };
    }

    const handle = await workspaceHandle(ctx);
    const merged = await remote.mergeTree(edge.targetTip, sha);
    const files = await fileChanges(remote, edge.targetTip, merged.tree);
    const [before, after] = await Promise.all([
        readBranchWorkspace(remote, edge.targetTip, handle),
        readBranchWorkspace(remote, merged.tree, handle),
    ]);
    const blocks: PreflightBlock[] = [];
    if (merged.conflicts.length > 0) {
        blocks.push({
            kind: 'conflicts',
            message: `Merging into ${edge.target.branch} conflicts in ${plural(merged.conflicts.length, 'file', 'files')}: ${merged.conflicts.join(', ')}.`,
        });
    }
    if (await targetAhead(remote, edge.sourceTip, edge.targetTip)) {
        blocks.push({
            kind: 'ahead',
            message: `${edge.target.env} is ahead of ${edge.source.env}: merge ${edge.target.branch} into ${edge.source.branch} first.`,
        });
    }
    const broken = await promotionRows(ctx, {
        kind: 'promotion',
        states: ['broken'],
        edge: { source: edge.source.env, target: edge.target.env },
    });
    if (broken.length > 0) {
        const shas = broken.map(row => shortSha(row.sha)).join(', ');
        blocks.push({
            kind: 'broken',
            message: `The lineage into ${edge.target.branch} is broken: ${shas} reached it by a squash or a rebase. Merge a repair first.`,
        });
    }
    const invalid = merged.conflicts.length === 0 ? invalidMerge(handle, after, edge.target.env) : null;
    if (invalid) {
        blocks.push(invalid);
    }
    if (files.length === 0) {
        blocks.push({ kind: 'empty', message: `Nothing to promote: ${edge.target.branch} already has every file of ${shortSha(sha)}.` });
    }

    const warnings = arrivalWarnings(handle, before, after, edge.target.env);
    const drafts = (await workingRows(ctx.db, ctx.workspaceId)).filter(isChange).map(row => row.path);
    if (drafts.length > 0) {
        warnings.push({
            kind: 'drafts',
            message: `${plural(drafts.length, 'change', 'changes')} not committed on ${edge.source.branch} stay behind: drafts never go.`,
            items: drafts,
        });
    }

    return {
        sha,
        branch,
        files,
        impact: { flows: flowImpact(before, after, handle), scripts: scriptImpact(before, after, handle) },
        blocks,
        warnings,
    };
}

const GraphQuery = z.object({ target: z.string().min(1, 'The target environment'), skip: z.coerce.number().int().min(0).optional() });

export class GetCommitGraphHandler implements UseCaseHandler<CommitGraph> {
    constructor(private readonly options: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<CommitGraph>> {
        const denied = requireRole(ctx, 'viewer') ?? (await gitOff(ctx));
        if (denied) {
            return denied;
        }
        const parsed = validate(GraphQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        return onWorkspaceRepository(ctx, this.options, async (remote, config) => {
            const edge = await edgeOut(remote, config.environment, parsed.value.target);
            return edge.ok ? success(await commitGraph(remote, edge.value, parsed.value.skip ?? 0)) : edge;
        });
    }
}

const PromotionInput = z.object({ target: z.string().min(1, 'The target environment'), sha: z.string().min(1, 'The commit to promote') });

async function preflightOf(
    ctx: UseCaseContext,
    remote: GitRemote,
    config: GitConfig,
    edge: Edge,
    sha: string,
): Promise<UseCaseResult<Preflight>> {
    if (edge.sourceTip && !(await onFirstParentLine(remote, sha, edge.sourceTip))) {
        return notOnLine(sha, edge);
    }
    const checked = await runPreflight(ctx, remote, edge, sha);
    const open = await openAlong(ctx, config, edge, { kind: 'promotion', source: edge.source.env, target: edge.target.env });
    return success({ ...checked, open });
}

export class GetPreflightHandler implements UseCaseHandler<Preflight> {
    constructor(private readonly options: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<Preflight>> {
        const denied = requireRole(ctx, 'viewer') ?? (await gitOff(ctx));
        if (denied) {
            return denied;
        }
        const parsed = validate(PromotionInput, input);
        if (!parsed.ok) {
            return parsed;
        }

        return onWorkspaceRepository(ctx, this.options, async (remote, config) => {
            const edge = await edgeOut(remote, config.environment, parsed.value.target);
            return edge.ok ? preflightOf(ctx, remote, config, edge.value, parsed.value.sha) : edge;
        });
    }
}

/** reused: an open promotion of the same commit on the edge; alsoOpen: the other open promotions on the edge */
export type OpenedPromotion = { promotion: Promotion; reused: boolean; alsoOpen: Promotion[]; provider: Provider | null };

export class OpenPromotionHandler implements UseCaseHandler<OpenedPromotion> {
    constructor(private readonly options: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<OpenedPromotion>> {
        const denied = requireRole(ctx, 'admin') ?? (await gitOff(ctx));
        if (denied) {
            return denied;
        }
        const parsed = validate(PromotionInput, input);
        if (!parsed.ok) {
            return parsed;
        }
        const { target, sha } = parsed.value;

        return onWorkspaceRepository(ctx, this.options, async (remote, config): Promise<UseCaseResult<OpenedPromotion>> => {
            const heads = await fetchAndFollow(ctx, remote, config);
            const edge = await edgeOut(remote, config.environment, target, heads);
            if (!edge.ok) {
                return edge;
            }
            const preflight = await preflightOf(ctx, remote, config, edge.value, sha);
            if (!preflight.ok) {
                return preflight;
            }
            const { blocks, open, branch } = preflight.value;
            const provider = await providerOf(config.repository);
            const same = open.find(p => p.sha === sha);
            if (same) {
                return success({ promotion: same, reused: true, alsoOpen: open.filter(p => p !== same), provider });
            }
            if (blocks.length > 0) {
                return fail('conflict', blocks.map(b => b.message).join(' '));
            }

            const pushed = heads.get(branch);
            if (pushed && pushed !== sha) {
                return fail('conflict', `The branch ${branch} is in the repository at another commit: delete it, then promote again.`);
            }
            if (!pushed) {
                await remote.push(sha, branch, null);
            }
            const id = crypto.randomUUID();
            await ctx.db.query(
                `INSERT INTO promotions (id, workspace_id, source, target, sha, branch, opened_by, state) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`,
                [id, ctx.workspaceId, edge.value.source.env, edge.value.target.env, sha, branch, ctx.userId],
            );
            const [row] = await promotionRows(ctx, { id });
            return success({
                promotion: toPromotion(row!, edgeLinks(edge.value, config, provider)),
                reused: false,
                alsoOpen: open,
                provider,
            });
        });
    }
}

/** reused: the repair branch was already pushed with the promoted sha in it */
export type OpenedRepair = { branch: string; reused: boolean; url: string | null; provider: Provider | null };

const RepairInput = z.object({ id: z.uuid('Invalid') });

export class OpenRepairHandler implements UseCaseHandler<OpenedRepair> {
    constructor(private readonly options: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<OpenedRepair>> {
        const denied = requireRole(ctx, 'admin') ?? (await gitOff(ctx));
        if (denied) {
            return denied;
        }
        const parsed = validate(RepairInput, input);
        if (!parsed.ok) {
            return parsed;
        }

        return onWorkspaceRepository(ctx, this.options, async (remote, config): Promise<UseCaseResult<OpenedRepair>> => {
            const heads = await fetchAndFollow(ctx, remote, config);
            const [row] = await promotionRows(ctx, { id: parsed.value.id });
            if (!row) {
                return fail('not-found', 'Promotion not found.');
            }
            if (row.state !== 'broken') {
                return fail('conflict', `Only a broken lineage takes a repair: this promotion is ${row.state}.`);
            }
            const far = row.source === config.environment ? row.target : row.source;
            const edge = await edgeOut(remote, config.environment, far, heads);
            if (!edge.ok) {
                return edge;
            }
            const into = rowEdge({ environments: [edge.value.source, edge.value.target] }, row)!.into;
            const intoTip = heads.get(into.branch);
            if (!intoTip) {
                return fail('conflict', `The branch ${into.branch} does not exist.`);
            }

            const branch = repairBranch(into.env, row.sha);
            const pushed = heads.get(branch);
            if (pushed && !(await remote.isAncestor(row.sha, pushed))) {
                return fail(
                    'conflict',
                    `The branch ${branch} is in the repository without ${shortSha(row.sha)}: delete it, then repair again.`,
                );
            }
            if (!pushed) {
                const commit = await remote.commit({
                    parent: intoTip,
                    changes: {},
                    message: `Repair the lineage of ${shortSha(row.sha)} into ${into.branch}\n\nA merge that keeps ${into.branch}'s tree: it changes no file.`,
                    author: await gitAuthorOf(ctx),
                    merge: { tree: intoTip, theirs: row.sha },
                });
                await remote.push(commit, branch, null);
            }
            const provider = await providerOf(config.repository);
            const url = provider ? pullRequestLink(config.repository, provider, branch, into.branch) : null;
            return success({ branch, reused: !!pushed, url, provider });
        });
    }
}
