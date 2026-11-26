import type { Database } from '#shared/database/database';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { branchKind, canEditBranch, currentBranch, listedHere, type BranchKind } from './current-branch';
import { gitBranch, readGitConfig, type GitOptions } from './git-config';
import type { Mode } from './topology';
import { onWorkspaceRepository } from './git-handlers';
import { readHeads, recordHeads } from './git-heads';
import { adapterOf } from './adapter-status';
import type { MergeRequestLink } from './merge-request';
import { unlessProviderFails } from './provider-adapter';
import type { Provider } from './pull-request';
import { ENVIRONMENT_BRANCH, type WorkingRow } from './working-copy';
import { changeCount } from './working-copy-changes';

export { branchKind, type BranchKind };

export type BranchView = {
    name: string;
    kind: Exclude<BranchKind, 'app'>;
    owner?: string;
    ownerName?: string;
    mine: boolean;
    editable: boolean;
    merged: boolean;
    changes: number;
    removed?: true;
    lostTip?: true;
    /** its open merge request into the environment's branch, with the adapter on */
    mergeRequest?: MergeRequestLink;
};

export type BranchesView = {
    current: string | null;
    environment: string | null;
    mode: Mode;
    branches: BranchView[];
    fetchedAt: string | null;
    /** with the adapter on: the provider the merge requests are on */
    provider?: Provider;
};

async function changesPerBranch(db: Database, workspaceId: string, environment: string | null): Promise<Map<string, number>> {
    const rows = await db.query<WorkingRow & { branch: string }>(
        `SELECT branch, path, content, deleted, file_id, base, edited_by, conflict, revision, updated_at FROM working_copy
       WHERE workspace_id = $1 ORDER BY path`,
        [workspaceId],
    );
    const byBranch = new Map<string, WorkingRow[]>();
    for (const row of rows) {
        const name = row.branch === ENVIRONMENT_BRANCH ? environment : row.branch;
        if (name !== null) {
            byBranch.set(name, [...(byBranch.get(name) ?? []), row]);
        }
    }
    return new Map([...byBranch].map(([name, list]) => [name, changeCount(list)]));
}

async function openMergeRequestsInto(
    ctx: UseCaseContext,
    environment: string | null,
): Promise<{ provider?: Provider; links: Map<string, MergeRequestLink> }> {
    const config = environment ? await readGitConfig(ctx.db, ctx.workspaceId) : null;
    const adapter = config ? await adapterOf(ctx, config) : null;
    if (!adapter || !environment) {
        return { links: new Map() };
    }
    const open = await unlessProviderFails(adapter.openPullRequestsInto(environment), []);
    return { provider: adapter.provider, links: new Map(open.map(m => [m.source, { number: m.number, url: m.url }])) };
}

const KIND_ORDER = { environment: 0, hotfix: 1, user: 2, shared: 3, backport: 4 };

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
        const [current, counts, [me], mergeRequests] = await Promise.all([
            currentBranch(ctx.db, ctx.workspaceId, ctx.userId),
            changesPerBranch(ctx.db, ctx.workspaceId, environment),
            ctx.db.query<{ handle: string }>('SELECT handle FROM users WHERE id::text = $1', [ctx.userId]),
            openMergeRequestsInto(ctx, environment),
        ]);
        const owners = new Map<string, string>();
        const handles = heads.heads.flatMap(h => branchKind(h.name, heads.environments).owner ?? []);
        for (const user of await ctx.db.query<{ handle: string; name: string }>(
            'SELECT handle, name FROM users WHERE handle = ANY($1::text[])',
            [handles],
        )) {
            owners.set(user.handle, user.name);
        }

        const editor = { handle: me?.handle ?? null, environments: heads.environments, targets: heads.targets ?? [], mode: git.mode };
        const branches: BranchView[] = [];
        for (const head of heads.heads) {
            const { kind, owner } = branchKind(head.name, heads.environments);
            const editable = canEditBranch(head.name, environment, editor);
            if (kind === 'app' || (kind === 'backport' && !editable) || !listedHere(head.name, kind, environment, git)) {
                continue;
            }
            const changes = counts.get(head.name) ?? 0;
            const mergeRequest = mergeRequests.links.get(head.name);
            branches.push({
                name: head.name,
                kind,
                ...(owner ? { owner, ...(owners.has(owner) ? { ownerName: owners.get(owner) } : {}) } : {}),
                mine: owner !== undefined && owner === me?.handle,
                editable: !head.removed && editable,
                merged: head.merged && changes === 0,
                changes,
                ...(head.removed ? { removed: true as const } : {}),
                ...(head.lostTip ? { lostTip: true as const } : {}),
                ...(mergeRequest ? { mergeRequest } : {}),
            });
        }
        branches.sort(
            (a, b) =>
                KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
                Number(b.name === environment) - Number(a.name === environment) ||
                Number(b.mine) - Number(a.mine) ||
                (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        );
        return success({
            current,
            environment,
            mode: git.mode,
            branches,
            fetchedAt: heads.at,
            ...(mergeRequests.provider ? { provider: mergeRequests.provider } : {}),
        });
    }
}
