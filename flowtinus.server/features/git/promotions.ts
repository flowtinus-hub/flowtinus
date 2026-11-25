import { z } from 'zod';
import { connectionFromYaml, repoEntry, repoFlowFromYaml, validateWorkspaceTree, type TreeIssue } from '@flowtinus/core';
import { workspaceHandle } from '#features/folders/project-tree';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { flowsIn } from './environments';
import { readGitState, type GitConfig, type GitOptions } from './git-config';
import { onWorkspaceRepository } from './git-handlers';
import { fetchHeads, recordHeads } from './git-heads';
import type { GitRemote } from './git-remote';
import { providerOf, type Provider } from './pull-request';
import { edgeIn, followPromotions, promotionRows, toPromotion, type Promotion } from './promotion-state';
import type { EnvironmentDecl } from './topology';
import { isChange, workingRows } from './working-copy';
import type { RepoFiles } from './workspace-export';
import { readBranchWorkspace } from './workspace-import';
import { readTopology } from './workspace-topology';

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

export type PreflightBlock = { kind: 'no-target' | 'conflicts' | 'ahead' | 'invalid' | 'empty'; message: string; issues?: TreeIssue[] };

export type PreflightWarning = { kind: 'connections' | 'triggers' | 'drafts'; message: string; items: string[] };

export type Preflight = {
    sha: string;
    files: FileChange[];
    impact: { flows: FlowImpact[]; scripts: ScriptImpact[] };
    blocks: PreflightBlock[];
    warnings: PreflightWarning[];
    open: Promotion[];
};

const GRAPH_PAGE = 200;
const CONTEXT_COMMITS = 3;
const NO_ENVIRONMENT = { connections: [], secrets: [], variables: [] };

export const promotionBranch = (source: string, sha: string) => `promote/${source}-${sha.slice(0, 12)}`;

type Edge = { source: EnvironmentDecl; target: EnvironmentDecl; sourceTip: string | null; targetTip: string | null };

async function edgeOut(
    remote: GitRemote,
    environment: string,
    target: string,
    branches?: Map<string, string>,
): Promise<UseCaseResult<Edge>> {
    const known = branches ?? (await remote.branches());
    const topology = await readTopology(remote, environment, known);
    const edge = topology.exists ? edgeIn(topology, environment, target) : null;
    if (!edge) {
        return fail(
            'conflict',
            `${environment} does not promote to ${target}: a server promotes only along the edges that leave its environment.`,
        );
    }
    return success({
        ...edge,
        sourceTip: await remote.fetch(edge.source.branch, known),
        targetTip: await remote.fetch(edge.target.branch, known),
    });
}

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
    const was = flowsIn(before, handle);
    const is = flowsIn(after, handle);
    const impact: FlowImpact[] = [];
    for (const [id, flow] of is) {
        const old = was.get(id);
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
    for (const [id, flow] of was) {
        if (!is.has(id)) {
            impact.push({ id, name: flow.name, changes: ['removed'] });
        }
    }
    return impact.sort((a, b) => a.name.localeCompare(b.name));
}

function scriptsIn(files: RepoFiles, handle: string): Map<string, string> {
    const scripts = new Map<string, string>();
    for (const [path, text] of Object.entries(files)) {
        const entry = repoEntry(path);
        if (entry.kind === 'script' && entry.workspace === handle) {
            scripts.set(`${entry.project}/${entry.path}`, text);
        }
    }
    return scripts;
}

function scriptImpact(before: RepoFiles, after: RepoFiles, handle: string): ScriptImpact[] {
    const was = scriptsIn(before, handle);
    const is = scriptsIn(after, handle);
    const impact: ScriptImpact[] = [
        ...[...is]
            .filter(([path, text]) => was.get(path) !== text)
            .map(([path]) => ({ path, change: was.has(path) ? 'changed' : 'added' }) as const),
        ...[...was.keys()].filter(path => !is.has(path)).map(path => ({ path, change: 'removed' }) as const),
    ];
    return impact.sort((a, b) => a.path.localeCompare(b.path));
}

function connectionsIn(files: RepoFiles, handle: string): Map<string, string> {
    const connections = new Map<string, string>();
    for (const [path, text] of Object.entries(files)) {
        const entry = repoEntry(path);
        const read = entry.kind === 'connection' && entry.workspace === handle ? connectionFromYaml(text) : null;
        if (entry.kind === 'connection' && read?.ok) {
            connections.set(read.value.id, entry.name);
        }
    }
    return connections;
}

function triggersIn(files: RepoFiles, handle: string): Map<string, string> {
    const triggers = new Map<string, string>();
    for (const [path, text] of Object.entries(files)) {
        const entry = repoEntry(path);
        if (entry.kind !== 'flow' || entry.workspace !== handle) {
            continue;
        }
        const read = repoFlowFromYaml(text, entry.name);
        if (!read.ok) {
            continue;
        }
        const flow = [entry.project, ...entry.folders, entry.name].join('/');
        read.value.schedules.forEach(s => triggers.set(s.id, `${flow}: schedule ${s.cron}`));
        read.value.webhooks.forEach(w => triggers.set(w.id, `${flow}: webhook ${w.name}`));
    }
    return triggers;
}

const newIn = (result: Map<string, string>, target: Map<string, string>) =>
    [...result]
        .filter(([id]) => !target.has(id))
        .map(([, name]) => name)
        .sort();

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function runPreflight(ctx: UseCaseContext, remote: GitRemote, edge: Edge, sha: string): Promise<Omit<Preflight, 'open'>> {
    const none = { sha, files: [], impact: { flows: [], scripts: [] }, warnings: [] };
    if (!edge.targetTip || !edge.sourceTip) {
        const message = `The branch ${edge.target.branch} does not exist: turning git on in ${edge.target.env} creates it.`;
        return { ...none, blocks: [{ kind: 'no-target', message }] };
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
    const backwards = await remote.mergeTree(edge.sourceTip, edge.targetTip);
    if ((await remote.changedPaths(edge.sourceTip, backwards.tree, [])).length > 0) {
        blocks.push({
            kind: 'ahead',
            message: `${edge.target.env} is ahead of ${edge.source.env}: merge ${edge.target.branch} into ${edge.source.branch} first.`,
        });
    }
    if (merged.conflicts.length === 0) {
        const { errors } = validateWorkspaceTree({ workspace: handle, files: after, environment: NO_ENVIRONMENT });
        if (errors.length > 0) {
            blocks.push({
                kind: 'invalid',
                message: `The merge result is not valid: ${edge.target.env} would refuse it (${plural(errors.length, 'error', 'errors')}).`,
                issues: errors,
            });
        }
    }
    if (files.length === 0) {
        blocks.push({ kind: 'empty', message: `Nothing to promote: ${edge.target.branch} already has every file of ${sha.slice(0, 12)}.` });
    }

    const warnings: PreflightWarning[] = [];
    const connections = newIn(connectionsIn(after, handle), connectionsIn(before, handle));
    if (connections.length > 0) {
        warnings.push({ kind: 'connections', message: `New to ${edge.target.env}: they arrive not configured.`, items: connections });
    }
    const triggers = newIn(triggersIn(after, handle), triggersIn(before, handle));
    if (triggers.length > 0) {
        warnings.push({ kind: 'triggers', message: `New to ${edge.target.env}: they arrive disabled.`, items: triggers });
    }
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

async function gitOff(ctx: UseCaseContext): Promise<UseCaseResult<never> | null> {
    return (await readGitState(ctx.db, ctx.workspaceId))?.on ? null : fail('conflict', 'Git is off in this workspace.');
}

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
    const links = {
        topology: { environments: [edge.source, edge.target] },
        repository: config.repository,
        provider: await providerOf(config.repository),
    };
    const open = (
        await promotionRows(ctx, `AND p.state = 'open' AND p.source = $2 AND p.target = $3`, [edge.source.env, edge.target.env])
    ).map(row => toPromotion(row, links));
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
            const heads = await fetchHeads(remote);
            await recordHeads(ctx, remote, config, heads);
            await followPromotions(ctx, remote, heads.fetched);

            const edge = await edgeOut(remote, config.environment, target, heads.fetched);
            if (!edge.ok) {
                return edge;
            }
            const preflight = await preflightOf(ctx, remote, config, edge.value, sha);
            if (!preflight.ok) {
                return preflight;
            }
            const { blocks, open } = preflight.value;
            if (blocks.length > 0) {
                return fail('conflict', blocks.map(b => b.message).join(' '));
            }

            const provider = await providerOf(config.repository);
            const same = open.find(p => p.sha === sha);
            if (same) {
                return success({ promotion: same, reused: true, alsoOpen: open.filter(p => p !== same), provider });
            }

            const branch = promotionBranch(edge.value.source.env, sha);
            const there = heads.fetched.get(branch);
            if (there && there !== sha) {
                return fail('conflict', `The branch ${branch} is in the repository at another commit: delete it, then promote again.`);
            }
            if (!there) {
                await remote.push(sha, branch, null);
            }
            const id = crypto.randomUUID();
            await ctx.db.query(
                `INSERT INTO promotions (id, workspace_id, source, target, sha, branch, opened_by, state) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`,
                [id, ctx.workspaceId, edge.value.source.env, edge.value.target.env, sha, branch, ctx.userId],
            );
            const links = { topology: { environments: [edge.value.source, edge.value.target] }, repository: config.repository, provider };
            const [row] = await promotionRows(ctx, 'AND p.id = $2', [id]);
            return success({ promotion: toPromotion(row!, links), reused: false, alsoOpen: open, provider });
        });
    }
}
