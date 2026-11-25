import { connectionFromYaml, repoFlowFromYaml, validateWorkspaceTree, type TreeIssue } from '@flowtinus/core';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { readGitState, type GitConfig } from './git-config';
import { fetchHeads, recordHeads } from './git-heads';
import type { GitRemote } from './git-remote';
import { edgeIn, followPromotions, promotionRows, toPromotion, type Promotion, type PromotionKind, type PromotionLinks } from './promotion-state';
import { providerOf, type Provider } from './pull-request';
import type { EnvironmentDecl } from './topology';
import { flowName, workspaceEntries, type RepoFiles } from './workspace-export';
import { readTopology } from './workspace-topology';

export type Edge = { source: EnvironmentDecl; target: EnvironmentDecl; sourceTip: string | null; targetTip: string | null };

export type PreflightWarning = {
    kind: 'connections' | 'triggers' | 'drafts' | 'emergency-rollback' | 'ends-emergency-rollback';
    message: string;
    items: string[];
};

const NO_ENVIRONMENT = { connections: [], secrets: [], variables: [] };

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function gitOff(ctx: UseCaseContext): Promise<UseCaseResult<never> | null> {
    return (await readGitState(ctx.db, ctx.workspaceId))?.on ? null : fail('conflict', 'Git is off in this workspace.');
}

export async function fetchAndFollow(ctx: UseCaseContext, remote: GitRemote, config: GitConfig): Promise<Map<string, string>> {
    const heads = await fetchHeads(remote);
    await recordHeads(ctx, remote, config, heads);
    await followPromotions(ctx, remote, heads.fetched);
    return heads.fetched;
}

export async function edgeOut(
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

export const edgeLinks = (edge: Edge, config: GitConfig, provider: Provider | null): PromotionLinks => ({
    topology: { environments: [edge.source, edge.target] },
    repository: config.repository,
    provider,
});

export async function openAlong(
    ctx: UseCaseContext,
    config: GitConfig,
    edge: Edge,
    row: { kind: PromotionKind; source: string; target: string },
): Promise<Promotion[]> {
    const links = edgeLinks(edge, config, await providerOf(config.repository));
    const rows = await promotionRows(ctx, { kind: row.kind, states: ['open'], edge: { source: row.source, target: row.target } });
    return rows.map(r => toPromotion(r, links));
}

export function invalidMerge(
    handle: string,
    merged: RepoFiles,
    into: string,
): { kind: 'invalid'; message: string; issues: TreeIssue[] } | null {
    const { errors } = validateWorkspaceTree({ workspace: handle, files: merged, environment: NO_ENVIRONMENT });
    return errors.length > 0
        ? {
              kind: 'invalid',
              message: `The merge result is not valid: ${into} would refuse it (${plural(errors.length, 'error', 'errors')}).`,
              issues: errors,
          }
        : null;
}

function connectionsIn(files: RepoFiles, handle: string): Map<string, string> {
    const connections = new Map<string, string>();
    for (const { entry, text } of workspaceEntries(files, handle, 'connection')) {
        const read = connectionFromYaml(text);
        if (read.ok) {
            connections.set(read.value.id, entry.name);
        }
    }
    return connections;
}

function triggersIn(files: RepoFiles, handle: string): Map<string, string> {
    const triggers = new Map<string, string>();
    for (const { entry, text } of workspaceEntries(files, handle, 'flow')) {
        const read = repoFlowFromYaml(text, entry.name);
        if (!read.ok) {
            continue;
        }
        const flow = flowName(entry);
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

export function arrivalWarnings(handle: string, before: RepoFiles, after: RepoFiles, into: string): PreflightWarning[] {
    const warnings: PreflightWarning[] = [];
    const connections = newIn(connectionsIn(after, handle), connectionsIn(before, handle));
    if (connections.length > 0) {
        warnings.push({ kind: 'connections', message: `New to ${into}: they arrive not configured.`, items: connections });
    }
    const triggers = newIn(triggersIn(after, handle), triggersIn(before, handle));
    if (triggers.length > 0) {
        warnings.push({ kind: 'triggers', message: `New to ${into}: they arrive disabled.`, items: triggers });
    }
    return warnings;
}
