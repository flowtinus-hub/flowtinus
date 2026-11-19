import type { Database } from '#shared/database/database';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { canEditBranch, currentBranch } from './current-branch';
import { gitBranch, type GitOptions } from './git-config';
import { onWorkspaceRepository } from './git-handlers';
import { readHeads, recordHeads } from './git-heads';
import { ENVIRONMENT_BRANCH, isChange } from './working-copy';

/**
 * A branch's kind, told by its name and the topology with nothing stored: an environment's (in the topology), the
 * app's own (never offered as a work branch), a user's (`users/<handle>/…`, its owner by the handle), or shared.
 */
export type BranchKind = 'environment' | 'app' | 'user' | 'shared';

export function branchKind(name: string, environments: string[]): { kind: BranchKind; owner?: string } {
    if (environments.includes(name)) {
        return { kind: 'environment' };
    }
    if (/^(promote|backport|hotfix|flowtinus)\//.test(name)) {
        return { kind: 'app' };
    }
    const user = /^users\/([^/]+)\/./.exec(name);
    return user ? { kind: 'user', owner: user[1]! } : { kind: 'shared' };
}

export type BranchView = {
    name: string;
    kind: Exclude<BranchKind, 'app'>;
    owner?: string;
    ownerName?: string;
    mine: boolean;
    editable: boolean;
    /** contained in the environment's branch with no uncommitted change: hidden behind "show merged" */
    merged: boolean;
    /** uncommitted changes on this server */
    changes: number;
};

export type BranchesView = { current: string | null; environment: string | null; branches: BranchView[]; fetchedAt: string | null };

async function changesPerBranch(db: Database, workspaceId: string, environment: string | null): Promise<Map<string, number>> {
    const rows = await db.query<{ branch: string; deleted: boolean; base: string | null; content: string | null }>(
        'SELECT branch, deleted, base, content FROM working_copy WHERE workspace_id = $1',
        [workspaceId],
    );
    const counts = new Map<string, number>();
    for (const row of rows.filter(isChange)) {
        const name = row.branch === ENVIRONMENT_BRANCH ? environment : row.branch;
        if (name !== null) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
    }
    return counts;
}

const KIND_ORDER = { environment: 0, user: 1, shared: 2 };

export class ListBranchesHandler implements UseCaseHandler<BranchesView> {
    constructor(private readonly options: GitOptions) {}

    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<BranchesView>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }
        const git = await gitBranch(ctx.db, ctx.workspaceId);
        if (!git) {
            return fail('conflict', 'Git is off in this workspace: there are no branches to pick.');
        }

        let heads = await readHeads(ctx.db, ctx.workspaceId);
        if (!heads) {
            const fetched = await onWorkspaceRepository(ctx, this.options, async (remote, config) =>
                success(await recordHeads(ctx, remote, config)),
            );
            if (!fetched.ok) {
                return fetched;
            }
            heads = fetched.value;
        }

        const environment = git.branch ?? heads.environment;
        const [current, counts, [me]] = await Promise.all([
            currentBranch(ctx.db, ctx.workspaceId, ctx.userId),
            changesPerBranch(ctx.db, ctx.workspaceId, environment),
            ctx.db.query<{ handle: string }>('SELECT handle FROM users WHERE id::text = $1', [ctx.userId]),
        ]);
        const owners = new Map<string, string>();
        const handles = heads.heads.flatMap(h => branchKind(h.name, heads.environments).owner ?? []);
        for (const user of await ctx.db.query<{ handle: string; name: string }>(
            'SELECT handle, name FROM users WHERE handle = ANY($1::text[])',
            [handles],
        )) {
            owners.set(user.handle, user.name);
        }

        const branches: BranchView[] = [];
        for (const head of heads.heads) {
            const { kind, owner } = branchKind(head.name, heads.environments);
            if (kind === 'app') {
                continue;
            }
            const changes = counts.get(head.name) ?? 0;
            branches.push({
                name: head.name,
                kind,
                ...(owner ? { owner, ...(owners.has(owner) ? { ownerName: owners.get(owner) } : {}) } : {}),
                mine: owner !== undefined && owner === me?.handle,
                editable: canEditBranch(head.name, environment),
                merged: head.merged && changes === 0,
                changes,
            });
        }
        branches.sort(
            (a, b) =>
                KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
                Number(b.name === environment) - Number(a.name === environment) ||
                Number(b.mine) - Number(a.mine) ||
                (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        );
        return success({ current, environment, branches, fetchedAt: heads.at });
    }
}
