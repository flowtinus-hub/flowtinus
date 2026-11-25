import { repoFlowFromYaml } from '@flowtinus/core';
import { contentHash } from '#features/deployments/deployments';
import { workspaceHandle } from '#features/folders/project-tree';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { readGitState, type GitConfig, type GitOptions } from './git-config';
import { onWorkspaceRepository } from './git-handlers';
import type { GitRemote } from './git-remote';
import { brokenPromotions, listPromotions, liveBackports, type Promotion } from './promotion-state';
import { providerOf } from './pull-request';
import type { LoggedOutcome } from './reconcile';
import type { EnvironmentDecl, Mode } from './topology';
import { exportWorkspace, flowName, workspaceEntries, type RepoFiles } from './workspace-export';
import { readBranchWorkspace } from './workspace-import';
import { readTopology } from './workspace-topology';

export type EnvironmentCard = { env: string; label: string; branch: string; mode: Mode; tip: string | null; here: boolean };

/**
 * behind: the files promoting the source's tip would change; ahead: merging the target into its source would change the source;
 * broken: this server's promotions along the edge whose lineage is broken, which block it until a repair is merged;
 * backports: this server's open and broken backports from the target into the source, which block nothing
 */
export type EnvironmentEdge = {
    source: string;
    target: string;
    targetExists: boolean;
    behind: number | null;
    ahead: boolean | null;
    broken: Promotion[];
    backports: Promotion[];
};

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
          promotions: Promotion[];
          reconciles: ReconcileEntry[];
      };

export type ReconcileEntry = { sha: string; outcome: LoggedOutcome; at: string };

const RECENT_RECONCILES = 20;

async function recentReconciles(ctx: UseCaseContext): Promise<ReconcileEntry[]> {
    const rows = await ctx.db.query<{ sha: string; outcome: ReconcileEntry['outcome']; at: Date }>(
        'SELECT sha, outcome, at FROM git_reconciles WHERE workspace_id = $1 ORDER BY at DESC LIMIT $2',
        [ctx.workspaceId, RECENT_RECONCILES],
    );
    return rows.map(r => ({ sha: r.sha, outcome: r.outcome, at: new Date(r.at).toISOString() }));
}

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

async function edgeOf(
    remote: GitRemote,
    source: string,
    target: string,
    tips: Map<string, string | null>,
): Promise<Omit<EnvironmentEdge, 'broken' | 'backports'>> {
    const from = tips.get(source) ?? null;
    const to = tips.get(target) ?? null;
    if (!from || !to) {
        return { source, target, targetExists: !!to, behind: null, ahead: null };
    }

    const promoted = await remote.mergeTree(to, from);
    return {
        source,
        target,
        targetExists: true,
        behind: (await remote.changedPaths(to, promoted.tree, [])).length,
        ahead: await targetAhead(remote, from, to),
    };
}

export async function targetAhead(remote: GitRemote, sourceTip: string, targetTip: string): Promise<boolean> {
    const backwards = await remote.mergeTree(sourceTip, targetTip);
    return backwards.conflicts.length > 0 || (await remote.changedPaths(sourceTip, backwards.tree, [])).length > 0;
}

export type FlowState = { name: string; deployed: boolean; hash: string };

export function flowsIn(files: RepoFiles, handle: string): Map<string, FlowState> {
    const flows = new Map<string, FlowState>();
    for (const { entry, text } of workspaceEntries(files, handle, 'flow')) {
        const read = repoFlowFromYaml(text, entry.name);
        if (read.ok && read.value.flow.id) {
            flows.set(read.value.flow.id, { name: flowName(entry), deployed: read.value.deployed, hash: contentHash(read.value.flow) });
        }
    }
    return flows;
}

const cellState = (flow: FlowState | undefined) => (!flow ? 'absent' : flow.deployed ? 'deployed' : 'undeployed');

function cellOf(flow: FlowState | undefined, here: FlowState | undefined, isHere: boolean): FlowCell {
    const state = cellState(flow);
    const content = isHere || !flow || !here ? null : flow.hash === here.hash ? 'same' : 'other';
    return { state, content, differs: state !== cellState(here) || (state === 'deployed' && content === 'other') };
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

async function readEnvironments(ctx: UseCaseContext, remote: GitRemote, config: GitConfig): Promise<EnvironmentsView> {
    const environment = config.environment;
    const branches = await remote.branches();
    const topology = await readTopology(remote, environment, branches);
    const activity = async (environments: EnvironmentDecl[]) => ({
        promotions: await listPromotions(ctx, { environments }, config.repository),
        reconciles: await recentReconciles(ctx),
    });
    if (!topology.exists) {
        const none = { environments: [], flows: [] };
        const problems = ['The repository has no topology.'];
        return { on: true, environment, problems, pipeline: [], edges: [], runsWhere: none, ...(await activity([])) };
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
    const links = { topology, repository: config.repository, provider: await providerOf(config.repository) };
    const [broken, backports] = await Promise.all([brokenPromotions(ctx, links), liveBackports(ctx, links)]);
    const edges: EnvironmentEdge[] = [];
    for (const e of ordered) {
        for (const target of e.promotesTo.filter(t => tips.has(t))) {
            const along = broken.filter(p => p.source === e.env && p.target === target);
            const back = backports.filter(p => p.source === target && p.target === e.env);
            edges.push({ ...(await edgeOf(remote, e.env, target, tips)), broken: along, backports: back });
        }
    }

    return {
        on: true,
        environment,
        problems: topology.problems,
        pipeline,
        edges,
        runsWhere: await runsWhere(ctx, remote, pipeline),
        ...(await activity(topology.environments)),
    };
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

        return onWorkspaceRepository(ctx, this.options, async (remote, config) => success(await readEnvironments(ctx, remote, config)));
    }
}
