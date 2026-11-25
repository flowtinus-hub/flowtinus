import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { GitRemote } from './git-remote';
import { CONFIG_BRANCH, parseTopology, type EnvironmentDecl } from './topology';
import { topologyAt } from './workspace-topology';
import { providerOf, pullRequestLink, type Provider } from './pull-request';

export type PromotionState = 'open' | 'broken' | 'merged' | 'closed';

/** url: the provider's page for a new pull request, while it is open; inTopology: its edge is still in the topology */
export type Promotion = {
    id: string;
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

const SELECT_PROMOTIONS = `SELECT p.id, p.source, p.target, p.sha, p.branch, p.state, u.name AS opened_by_name, p.opened_at
  FROM promotions p LEFT JOIN users u ON u.id::text = p.opened_by WHERE p.workspace_id = $1`;

const RECENT_PROMOTIONS = 50;

export async function promotionRows(ctx: UseCaseContext, filter = '', params: unknown[] = []): Promise<PromotionRow[]> {
    return ctx.db.query<PromotionRow>(`${SELECT_PROMOTIONS} ${filter} ORDER BY p.opened_at DESC LIMIT ${RECENT_PROMOTIONS}`, [
        ctx.workspaceId,
        ...params,
    ]);
}

export type PromotionLinks = { topology: Topology; repository: string; provider: Provider | null };

export function toPromotion(row: PromotionRow, links: PromotionLinks): Promotion {
    const edge = edgeIn(links.topology, row.source, row.target);
    return {
        id: row.id,
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
                ? pullRequestLink(links.repository, links.provider, row.branch, edge.target.branch)
                : null,
    };
}

export async function listPromotions(ctx: UseCaseContext, topology: Topology, repository: string): Promise<Promotion[]> {
    const links = { topology, repository, provider: await providerOf(repository) };
    return (await promotionRows(ctx)).map(row => toPromotion(row, links));
}

/** every broken row, whatever its age: each blocks its edge until it is merged */
export async function brokenPromotions(ctx: UseCaseContext, links: PromotionLinks): Promise<Promotion[]> {
    const rows = await ctx.db.query<PromotionRow>(`${SELECT_PROMOTIONS} AND p.state = 'broken' ORDER BY p.opened_at DESC`, [
        ctx.workspaceId,
    ]);
    return rows.map(row => toPromotion(row, links));
}

async function stateOf(
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

/** merging the sha into the target would change nothing: the target holds its content, though not the commit */
async function hasContentOf(remote: GitRemote, targetTip: string, sha: string): Promise<boolean> {
    const merged = await remote.mergeTree(targetTip, sha);
    return merged.tree === (await remote.run(['rev-parse', `${targetTip}^{tree}`])).trim();
}

/** the open and broken rows of the edges still in the topology, worked out again from the heads just fetched; merged and closed are final, broken ends only as merged */
export async function followPromotions(ctx: UseCaseContext, remote: GitRemote, heads: Map<string, string>): Promise<void> {
    const rows = await ctx.db.query<PromotionRow>(
        `SELECT id, source, target, sha, branch, state, NULL AS opened_by_name, opened_at FROM promotions WHERE workspace_id = $1 AND state IN ('open', 'broken')`,
        [ctx.workspaceId],
    );
    const configTip = heads.get(CONFIG_BRANCH);
    const text = rows.length > 0 && configTip ? await topologyAt(remote, configTip) : null;
    if (text === null) {
        return;
    }
    const topology = parseTopology(text);
    for (const row of rows) {
        const edge = edgeIn(topology, row.source, row.target);
        if (!edge) {
            continue;
        }
        const state = await stateOf(remote, row, heads.get(edge.target.branch), heads);
        if (state !== row.state) {
            await ctx.db.query(`UPDATE promotions SET state = $2, state_at = now() WHERE id = $1 AND state = $3`, [
                row.id,
                state,
                row.state,
            ]);
        }
    }
}
