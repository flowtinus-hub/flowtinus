import { workspaceSlug } from '#features/folders/project-tree';
import { readWorkspaceSetting, writeWorkspaceSetting } from '#features/workspaces/workspace-settings';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseResult } from '#shared/use-cases/use-case-result';
import { lockBranch } from './branch-write';
import { HEADS_SETTING, type GitConfig } from './git-config';
import { GitError, type GitRemote } from './git-remote';
import { dropPendingMerge, pendingMerge } from './pending-merge';
import { reconcile, type ReconcileResult } from './reconcile';
import { CONFIG_BRANCH, parseTopology } from './topology';
import { ENVIRONMENT_BRANCH, followGit, isChange, workingRows } from './working-copy';
import { readBranchWorkspace } from './workspace-import';
import { topologyAt } from './workspace-topology';

export type Head = { name: string; sha: string; merged: boolean; removed?: true; lostTip?: true };

export type Heads = { at: string; environment: string | null; environments: string[]; heads: Head[] };

export const readHeads = async (db: Database, workspaceId: string) =>
    (await readWorkspaceSetting(db, workspaceId, HEADS_SETTING)) as Heads | null;

/** since: before the fetch; cloned: the clone's tips before the fetch pruned the branches gone from the remote */
export type FetchedHeads = { since: Date; cloned: Map<string, string>; fetched: Map<string, string> };

export async function fetchHeads(remote: GitRemote): Promise<FetchedHeads> {
    const since = new Date();
    const cloned = await clonedTips(remote);
    return { since, cloned, fetched: await remote.fetchHeads() };
}

export async function recordHeads(ctx: UseCaseContext, remote: GitRemote, config: GitConfig, at?: FetchedHeads): Promise<Heads> {
    const { since, cloned, fetched } = at ?? (await fetchHeads(remote));
    const configTip = fetched.get(CONFIG_BRANCH);
    const text = configTip ? await topologyAt(remote, configTip) : null;
    const environments = text === null ? [] : parseTopology(text).environments;
    const environment = environments.find(e => e.env === config.environment)?.branch ?? null;
    const envTip = environment ? fetched.get(environment) : undefined;

    const before = await readHeads(ctx.db, ctx.workspaceId);
    const beforeTip = before?.environment ? before.heads.find(h => h.name === before.environment)?.sha : undefined;
    const known = new Map((before?.heads ?? []).map(h => [h.name, h]));
    const heads: Head[] = [];
    for (const [name, sha] of fetched) {
        const was = known.get(name);
        const merged =
            !envTip || name === environment
                ? false
                : was && !was.removed && was.sha === sha && beforeTip === envTip && before?.environment === environment
                  ? was.merged
                  : await remote.isAncestor(sha, envTip);
        heads.push({ name, sha, merged });
    }
    heads.push(...(await followBranches(ctx, remote, fetched, known, cloned, environment, envTip)));
    heads.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // whoever was on a branch gone from the remote is back on the environment's (one picked during the fetch stays)
    await ctx.db.query('DELETE FROM user_branches WHERE workspace_id = $1 AND NOT (branch = ANY($2::text[])) AND updated_at < $3', [
        ctx.workspaceId,
        heads.map(h => h.name),
        since,
    ]);

    const value: Heads = { at: new Date().toISOString(), environment, environments: environments.map(e => e.branch), heads };
    await writeWorkspaceSetting(ctx.db, ctx.workspaceId, HEADS_SETTING, value, ctx.userId);
    return value;
}

const KEPT = 'refs/flowtinus/kept/';
const keptRef = (branch: string) => `${KEPT}${branch}`;

async function clonedTips(remote: GitRemote): Promise<Map<string, string>> {
    const out = await remote.run(['for-each-ref', '--format=%(objectname) %(refname)', KEPT, 'refs/remotes/origin/']);
    const tips = new Map<string, string>();
    for (const line of out.split('\n').filter(Boolean)) {
        const [sha, ref] = line.split(' ') as [string, string];
        if (ref.startsWith(KEPT)) {
            tips.set(ref.slice(KEPT.length), sha);
        } else {
            const name = ref.slice('refs/remotes/origin/'.length);
            if (!tips.has(name)) {
                tips.set(name, sha);
            }
        }
    }
    return tips;
}

async function followBranches(
    ctx: UseCaseContext,
    remote: GitRemote,
    fetched: Map<string, string>,
    known: Map<string, Head>,
    cloned: Map<string, string>,
    environment: string | null,
    envTip: string | undefined,
): Promise<Head[]> {
    const branches = await ctx.db.query<{ branch: string }>(
        'SELECT DISTINCT branch FROM working_copy WHERE workspace_id = $1 AND branch <> $2 ORDER BY branch',
        [ctx.workspaceId, ENVIRONMENT_BRANCH],
    );
    const slug = await workspaceSlug(ctx);
    const removed: Head[] = [];
    for (const { branch } of branches) {
        if (branch === environment) {
            continue;
        }
        const was = known.get(branch);
        const sha = fetched.get(branch);
        if (sha) {
            if (was?.removed) {
                await dropKeptRef(remote, branch);
            }
            if (was?.sha === sha && !was.removed) {
                continue;
            }
            const tip = await readBranchWorkspace(remote, sha, slug);
            await ctx.db.transaction(async db => {
                await lockBranch(db, ctx.workspaceId, branch);
                // a Commit from this server moved it during the fetch: the next poll merges onto what it pushed
                const noted = (await readHeads(db, ctx.workspaceId))?.heads.find(h => h.name === branch)?.sha;
                if (noted && noted !== was?.sha && noted !== sha) {
                    return;
                }
                // a pending merge keeps its files and marks as the Update left them: its Commit refuses a moved branch, its abort merges
                if (await pendingMerge(db, ctx.workspaceId, branch)) {
                    return;
                }
                await followGit(db, ctx.workspaceId, tip, sha, branch);
            });
            continue;
        }

        const changed = (await workingRows(ctx.db, ctx.workspaceId, branch)).some(isChange);
        // the recorded heads are gone after git off then on: the clone may still have the branch's last tip
        const last = was && !was.lostTip ? was.sha : cloned.get(branch);
        if (changed && last) {
            if (!was?.removed || was.lostTip) {
                await keepRef(remote, branch, last);
            }
            removed.push({ name: branch, sha: last, merged: false, removed: true });
            continue;
        }
        if (changed && envTip) {
            removed.push({ name: branch, sha: envTip, merged: false, removed: true, lostTip: true });
            continue;
        }
        if (!changed) {
            await ctx.db.transaction(async db => {
                await lockBranch(db, ctx.workspaceId, branch);
                await db.query('DELETE FROM working_copy WHERE workspace_id = $1 AND branch = $2', [ctx.workspaceId, branch]);
                await dropPendingMerge(db, ctx.workspaceId, branch);
            });
            if (was?.removed) {
                await dropKeptRef(remote, branch);
            }
        }
    }
    return removed;
}

async function keepRef(remote: GitRemote, branch: string, sha: string): Promise<void> {
    try {
        await remote.run(['update-ref', keptRef(branch), sha]);
    } catch (e) {
        // a name that cannot be a ref next to another one kept (a and a/b): the tip is then only as safe as git's gc lets it be
        if (!(e instanceof GitError)) {
            throw e;
        }
    }
}

async function dropKeptRef(remote: GitRemote, branch: string): Promise<void> {
    try {
        await remote.run(['update-ref', '-d', keptRef(branch)]);
    } catch (e) {
        if (!(e instanceof GitError)) {
            throw e;
        }
    }
}

export async function fetchAndReconcile(
    ctx: UseCaseContext,
    remote: GitRemote,
    config: GitConfig,
): Promise<UseCaseResult<ReconcileResult>> {
    const heads = await fetchHeads(remote);
    const result = await reconcile(ctx, remote, config, heads.fetched);
    await recordHeads(ctx, remote, config, heads);
    return result;
}
