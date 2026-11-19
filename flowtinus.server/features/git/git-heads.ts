import { readWorkspaceSetting, writeWorkspaceSetting } from '#features/workspaces/workspace-settings';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseResult } from '#shared/use-cases/use-case-result';
import { HEADS_SETTING, type GitConfig } from './git-config';
import type { GitRemote } from './git-remote';
import { reconcile, type ReconcileResult } from './reconcile';
import { CONFIG_BRANCH, parseTopology, TOPOLOGY_FILE } from './topology';

/** merged: contained in the environment's branch (never the environment's branch itself) */
export type Head = { name: string; sha: string; merged: boolean };

/** the remote's heads as the last fetch found them; environments: the branches the topology gives an environment */
export type Heads = { at: string; environment: string | null; environments: string[]; heads: Head[] };

export const readHeads = async (db: Database, workspaceId: string) =>
    (await readWorkspaceSetting(db, workspaceId, HEADS_SETTING)) as Heads | null;

/** every head fetched and kept with whether the environment's branch contains it */
export async function recordHeads(ctx: UseCaseContext, remote: GitRemote, config: GitConfig): Promise<Heads> {
    const fetched = await remote.fetchHeads();
    const configTip = fetched.get(CONFIG_BRANCH);
    const text = configTip ? await remote.readFile(configTip, TOPOLOGY_FILE) : null;
    const environments = text === null ? [] : parseTopology(text).environments;
    const environment = environments.find(e => e.env === config.environment)?.branch ?? null;
    const envTip = environment ? fetched.get(environment) : undefined;

    const before = await readHeads(ctx.db, ctx.workspaceId);
    const beforeTip = before?.environment ? before.heads.find(h => h.name === before.environment)?.sha : undefined;
    const known = new Map((before?.heads ?? []).map(h => [h.name, h]));
    const heads: Head[] = [];
    for (const [name, sha] of [...fetched].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const was = known.get(name);
        // asked of git again only when the head or the environment's branch moved
        const merged =
            !envTip || name === environment
                ? false
                : was && was.sha === sha && beforeTip === envTip && before?.environment === environment
                  ? was.merged
                  : await remote.isAncestor(sha, envTip);
        heads.push({ name, sha, merged });
    }

    const value: Heads = { at: new Date().toISOString(), environment, environments: environments.map(e => e.branch), heads };
    await writeWorkspaceSetting(ctx.db, ctx.workspaceId, HEADS_SETTING, value, ctx.userId);
    return value;
}

/** a poll's work (and Reconcile now's): only the environment's branch is reconciled, every head is fetched */
export async function fetchAndReconcile(
    ctx: UseCaseContext,
    remote: GitRemote,
    config: GitConfig,
): Promise<UseCaseResult<ReconcileResult>> {
    const result = await reconcile(ctx, remote, config);
    await recordHeads(ctx, remote, config);
    return result;
}
