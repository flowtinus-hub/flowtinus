import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { GitRemote } from './git-remote';
import { CONFIG_BRANCH, parseTopology, type EnvironmentDecl } from './topology';
import { topologyAt } from './workspace-topology';
import { providerOf, pullRequestLink, type Provider } from './pull-request';

export type PromotionState = 'open' | 'broken' | 'merged' | 'closed';

/** a backport runs against its edge: from the environment ahead (source) into the one it is promoted from (target) */
export type PromotionKind = 'promotion' | 'backport';

/** url: the provider's page for a new pull request, while it is open; inTopology: its edge is still in the topology */
export type Promotion = {
    id: string;
    kind: PromotionKind;
    source: string;
    target: string;
    sha: string;
    branch: string;
    state: PromotionState;
    openedBy: string | null;
    openedAt: string;
    inTopology: boolean;
    url: string | null;
};

export type Topology = { environments: EnvironmentDecl[] };

export type PromotionRow = {
    id: string;
    kind: PromotionKind;
    source: string;
    target: string;
    sha: string;
    branch: string;
    state: PromotionState;
    opened_by_name: string | null;
    opened_at: Date;
};

export const edgeIn = (topology: Topology, source: string, target: string) => {
    const from = topology.environments.find(e => e.env === source);
    const to = topology.environments.find(e => e.env === target);
    return from && to && from.promotesTo.includes(target) ? { source: from, target: to } : null;
};

/** the topology edge a row runs along, and the environment its branch merges into */
function rowEdge(topology: Topology, row: Pick<PromotionRow, 'kind' | 'source' | 'target'>) {
    if (row.kind === 'backport') {
        const edge = edgeIn(topology, row.target, row.source);
        return edge && { ...edge, into: edge.source };
    }
    const edge = edgeIn(topology, row.source, row.target);
    return edge && { ...edge, into: edge.target };
}

const SELECT_PROMOTIONS = `SELECT p.id, p.kind, p.source, p.target, p.sha, p.branch, p.state, u.name AS opened_by_name, p.opened_at
  FROM promotions p LEFT JOIN users u ON u.id::text = p.opened_by WHERE p.workspace_id = $1`;

const RECENT_PROMOTIONS = 50;

export const shortSha = (sha: string) => sha.slice(0, 12);

export type PromotionQuery = {
    id?: string;
    kind?: PromotionKind;
    states?: PromotionState[];
    edge?: { source: string; target: string };
    limit?: number;
};

export async function promotionRows(ctx: UseCaseContext, query: PromotionQuery = {}): Promise<PromotionRow[]> {
    const params: unknown[] = [ctx.workspaceId];
    const conditions: string[] = [];
    const where = (column: string, value: string) => {
        params.push(value);
        conditions.push(`AND ${column} = $${params.length}`);
    };
    if (query.id) {
        where('p.id', query.id);
    }
    if (query.kind) {
        where('p.kind', query.kind);
    }
    if (query.states) {
        params.push(query.states);
        conditions.push(`AND p.state = ANY($${params.length})`);
    }
    if (query.edge) {
        where('p.source', query.edge.source);
        where('p.target', query.edge.target);
    }
    const limit = query.limit ? ` LIMIT ${query.limit}` : '';
    return ctx.db.query<PromotionRow>(`${SELECT_PROMOTIONS} ${conditions.join(' ')} ORDER BY p.opened_at DESC${limit}`, params);
}

export type PromotionLinks = { topology: Topology; repository: string; provider: Provider | null };

export function toPromotion(row: PromotionRow, links: PromotionLinks): Promotion {
    const edge = rowEdge(links.topology, row);
    return {
        id: row.id,
        kind: row.kind,
        source: row.source,
        target: row.target,
        sha: row.sha,
        branch: row.branch,
        state: row.state,
        openedBy: row.opened_by_name,
        openedAt: new Date(row.opened_at).toISOString(),
        inTopology: !!edge,
        url:
            edge && links.provider && row.state === 'open'
                ? pullRequestLink(links.repository, links.provider, row.branch, edge.into.branch)
                : null,
    };
}

export async function listPromotions(ctx: UseCaseContext, topology: Topology, repository: string): Promise<Promotion[]> {
    const links = { topology, repository, provider: await providerOf(repository) };
    return (await promotionRows(ctx, { limit: RECENT_PROMOTIONS })).map(row => toPromotion(row, links));
}

/** every broken promotion, whatever its age: each blocks its edge until it is merged */
export async function brokenPromotions(ctx: UseCaseContext, links: PromotionLinks): Promise<Promotion[]> {
    return (await promotionRows(ctx, { kind: 'promotion', states: ['broken'] })).map(row => toPromotion(row, links));
}

/** open and broken backports, which block nothing */
export async function liveBackports(ctx: UseCaseContext, links: PromotionLinks): Promise<Promotion[]> {
    return (await promotionRows(ctx, { kind: 'backport', states: ['open', 'broken'] })).map(row => toPromotion(row, links));
}

async function stateInGit(
    remote: GitRemote,
    row: PromotionRow,
    targetTip: string | undefined,
    heads: Map<string, string>,
): Promise<PromotionState> {
    if (targetTip && (await remote.isAncestor(row.sha, targetTip))) {
        return 'merged';
    }
    if (row.state === 'broken') {
        return 'broken';
    }
    if (targetTip && (await hasContentOf(remote, targetTip, row.sha))) {
        return 'broken';
    }
    if (!heads.has(row.branch)) {
        return 'closed';
    }
    return 'open';
}

async function hasContentOf(remote: GitRemote, targetTip: string, sha: string): Promise<boolean> {
    const merged = await remote.mergeTree(targetTip, sha);
    return merged.tree === (await remote.run(['rev-parse', `${targetTip}^{tree}`])).trim();
}

/** merged and closed are final; broken ends only as merged */
export async function followPromotions(ctx: UseCaseContext, remote: GitRemote, heads: Map<string, string>): Promise<void> {
    const rows = await ctx.db.query<PromotionRow>(
        `SELECT id, kind, source, target, sha, branch, state, NULL AS opened_by_name, opened_at FROM promotions WHERE workspace_id = $1 AND state IN ('open', 'broken')`,
        [ctx.workspaceId],
    );
    const configTip = heads.get(CONFIG_BRANCH);
    const text = rows.length > 0 && configTip ? await topologyAt(remote, configTip) : null;
    if (text === null) {
        return;
    }
    const topology = parseTopology(text);
    for (const row of rows) {
        const edge = rowEdge(topology, row);
        if (!edge) {
            continue;
        }
        const state = await stateInGit(remote, row, heads.get(edge.into.branch), heads);
        if (state !== row.state) {
            await ctx.db.query(`UPDATE promotions SET state = $2, state_at = now() WHERE id = $1 AND state = $3`, [
                row.id,
                state,
                row.state,
            ]);
        }
    }
}
