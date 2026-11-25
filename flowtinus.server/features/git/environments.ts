import { repoEntry, repoFlowFromYaml } from '@flowtinus/core';
import { contentHash } from '#features/deployments/deployments';
import { workspaceHandle } from '#features/folders/project-tree';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { readGitState, type GitOptions } from './git-config';
import { onWorkspaceRepository } from './git-handlers';
import type { GitRemote } from './git-remote';
import type { EnvironmentDecl, Mode } from './topology';
import { exportWorkspace, type RepoFiles } from './workspace-export';
import { readBranchWorkspace } from './workspace-import';
import { readTopology } from './workspace-topology';

export type EnvironmentCard = { env: string; label: string; branch: string; mode: Mode; tip: string | null; here: boolean };

/** behind: the files promoting the source's tip would change; ahead: merging the target into its source would change the source */
export type EnvironmentEdge = { source: string; target: string; targetExists: boolean; behind: number | null; ahead: boolean | null };

/** content: compared with this server's version of the flow (null when either side has none); differs: it does not run as here */
export type FlowCell = { state: 'deployed' | 'undeployed' | 'absent'; content: 'same' | 'other' | null; differs: boolean };

/** name: the flow's path in its project, from this server unless it is absent here; a cell is null where the branch does not exist */
export type FlowRow = { id: string; name: string; cells: Record<string, FlowCell | null> };

export type RunsWhere = { environments: string[]; flows: FlowRow[] };

export type EnvironmentsView =
    | { on: false }
    | {
          on: true;
          environment: string;
          problems: string[];
          pipeline: EnvironmentCard[];
          edges: EnvironmentEdge[];
          runsWhere: RunsWhere;
      };

/** the roots first, each followed by what it promotes to, depth first in the order the topology declares them */
function pipelineOrder(environments: EnvironmentDecl[]): EnvironmentDecl[] {
    const byName = new Map(environments.map(e => [e.env, e]));
    const targets = new Set(environments.flatMap(e => e.promotesTo));
    const ordered: EnvironmentDecl[] = [];
    const visit = (e: EnvironmentDecl) => {
        if (ordered.includes(e)) {
            return;
        }
        ordered.push(e);
        e.promotesTo.forEach(t => byName.has(t) && visit(byName.get(t)!));
    };
    environments.filter(e => !targets.has(e.env)).forEach(visit);
    // a cycle has no root: what it left out still shows
    environments.forEach(visit);
    return ordered;
}

async function edgeOf(remote: GitRemote, source: string, target: string, tips: Map<string, string | null>): Promise<EnvironmentEdge> {
    const from = tips.get(source) ?? null;
    const to = tips.get(target) ?? null;
    if (!from || !to) {
        return { source, target, targetExists: !!to, behind: null, ahead: null };
    }

    const promoted = await remote.mergeTree(to, from);
    const backwards = await remote.mergeTree(from, to);
    return {
        source,
        target,
        targetExists: true,
        behind: (await remote.changedPaths(to, promoted.tree, [])).length,
        ahead: (await remote.changedPaths(from, backwards.tree, [])).length > 0,
    };
}

type FlowState = { name: string; deployed: boolean; hash: string };

function flowsIn(files: RepoFiles, handle: string): Map<string, FlowState> {
    const flows = new Map<string, FlowState>();
    for (const [path, text] of Object.entries(files)) {
        const entry = repoEntry(path);
        if (entry.kind !== 'flow' || entry.workspace !== handle) {
            continue;
        }
        const read = repoFlowFromYaml(text, entry.name);
        if (read.ok && read.value.flow.id) {
            const name = [entry.project, ...entry.folders, entry.name].join('/');
            flows.set(read.value.flow.id, { name, deployed: read.value.deployed, hash: contentHash(read.value.flow) });
        }
    }
    return flows;
}

const stateOf = (flow: FlowState | undefined) => (!flow ? 'absent' : flow.deployed ? 'deployed' : 'undeployed');

function cellOf(flow: FlowState | undefined, here: FlowState | undefined, isHere: boolean): FlowCell {
    const state = stateOf(flow);
    const content = isHere || !flow || !here ? null : flow.hash === here.hash ? 'same' : 'other';
    return { state, content, differs: state !== stateOf(here) || (state === 'deployed' && content === 'other') };
}

async function runsWhere(ctx: UseCaseContext, remote: GitRemote, pipeline: EnvironmentCard[]): Promise<RunsWhere> {
    const handle = await workspaceHandle(ctx);
    const here = flowsIn(await exportWorkspace(ctx.db, ctx.workspaceId), handle);
    const columns = new Map<string, Map<string, FlowState> | null>();
    for (const card of pipeline) {
        columns.set(card.env, card.here ? here : card.tip ? flowsIn(await readBranchWorkspace(remote, card.tip, handle), handle) : null);
    }

    const ids = new Set([...columns.values()].flatMap(flows => [...(flows?.keys() ?? [])]));
    const flows = [...ids].map(id => ({
        id,
        name: here.get(id)?.name ?? [...columns.values()].find(flows => flows?.has(id))!.get(id)!.name,
        cells: Object.fromEntries(
            pipeline.map(card => {
                const flows = columns.get(card.env);
                return [card.env, flows ? cellOf(flows.get(id), here.get(id), card.here) : null];
            }),
        ),
    }));
    return { environments: pipeline.map(c => c.env), flows: flows.sort((a, b) => a.name.localeCompare(b.name)) };
}

async function readEnvironments(ctx: UseCaseContext, remote: GitRemote, environment: string): Promise<EnvironmentsView> {
    const branches = await remote.branches();
    const topology = await readTopology(remote, environment, branches);
    if (!topology.exists) {
        const none = { environments: [], flows: [] };
        return { on: true, environment, problems: ['The repository has no topology.'], pipeline: [], edges: [], runsWhere: none };
    }

    const ordered = pipelineOrder(topology.environments);
    const tips = new Map<string, string | null>();
    for (const e of ordered) {
        tips.set(e.env, await remote.fetch(e.branch, branches));
    }

    const pipeline = ordered.map(({ env, label, branch, mode }) => ({
        env,
        label,
        branch,
        mode,
        tip: tips.get(env)!,
        here: env === environment,
    }));
    const edges: EnvironmentEdge[] = [];
    for (const e of ordered) {
        for (const target of e.promotesTo.filter(t => tips.has(t))) {
            edges.push(await edgeOf(remote, e.env, target, tips));
        }
    }

    return { on: true, environment, problems: topology.problems, pipeline, edges, runsWhere: await runsWhere(ctx, remote, pipeline) };
}

export class GetEnvironmentsHandler implements UseCaseHandler<EnvironmentsView> {
    constructor(private readonly options: GitOptions) {}

    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<EnvironmentsView>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }
        if (!(await readGitState(ctx.db, ctx.workspaceId))?.on) {
            return success({ on: false });
        }

        return onWorkspaceRepository(ctx, this.options, async (remote, config) =>
            success(await readEnvironments(ctx, remote, config.environment)),
        );
    }
}
