import { fieldErrors } from '#shared/use-cases/field-errors';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { z } from 'zod';
import { findTokenSecret, gitAccess, gitAuthorOf, gitConfigSchema, readGitConfig, readGitState, removeGitConfig, saveGitConfig, type GitConfig, type GitOptions } from './git-config';
import { GitError, withThrowawayClone, withWorkspaceClone, type GitRemote } from './git-remote';
import { branchNameError, CONFIG_BRANCH, TOPOLOGY_FILE, topologyYaml, type EnvironmentDecl, type Mode } from './topology';
import { readTopology, type TopologyView } from './workspace-topology';
import { turnGitOn, turnOnPlan, type TurnOnOutcome, type TurnOnPlan } from './turn-git-on';
import type { TreeIssue } from '@flowtinus/core';
import { forgetReconcile, lockReconcile, type ReconcileResult } from './reconcile';
import { ensureHookToken, forgetHookToken, hookPath, readHookToken, renewHookToken } from './git-hook';
import { readLastPoll, recordPoll, type LastPoll } from './git-poll-state';
import { readState } from './reconcile';
import { fetchAndReconcile } from './git-heads';
import { workspaceHandle } from '#features/folders/project-tree';

/** hook (admins): the webhook's path on the server; lastPoll: the last fetch of the environment's branch, and why it could not reconcile */
export type GitConfigView = { config: GitConfig | null; on: boolean; hook?: string; lastPoll?: LastPoll };

export class GetGitConfigHandler implements UseCaseHandler<GitConfigView> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<GitConfigView>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }

        const state = await readGitState(ctx.db, ctx.workspaceId);
        const token = ctx.role === 'admin' ? await readHookToken(ctx.db, ctx.workspaceId) : null;
        const lastPoll = state?.on ? await readLastPoll(ctx.db, ctx.workspaceId) : null;
        return success({
            config: state?.config ?? null,
            on: state?.on ?? false,
            ...(token ? { hook: hookPath(await workspaceHandle(ctx), token) } : {}),
            ...(lastPoll ? { lastPoll } : {}),
        });
    }
}

async function validConfig(input: unknown, ctx: UseCaseContext, options: GitOptions): Promise<UseCaseResult<GitConfig>> {
    const parsed = validate(gitConfigSchema(options), input);
    if (!parsed.ok) {
        return parsed;
    }

    const secret = await findTokenSecret(ctx, parsed.value.tokenSecret);
    return (
        fieldErrors({ tokenSecret: secret ? undefined : 'No secret with this name' }) ??
        success({ ...parsed.value, tokenSecret: secret!.name })
    );
}

export class SaveGitConfigHandler implements UseCaseHandler<{ config: GitConfig; on: boolean }> {
    constructor(private readonly options: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ config: GitConfig; on: boolean }>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const config = await validConfig(input, ctx, this.options);
        if (!config.ok) {
            return config;
        }

        const on = await ctx.db.transaction(async db => {
            const tx = { ...ctx, db };
            // waits for a running reconcile, which would write the deployed set after it is forgotten
            await lockReconcile(db, ctx.workspaceId);
            const saved = await readGitState(db, ctx.workspaceId);
            const stays =
                !!saved?.on && saved.config.repository === config.value.repository && saved.config.environment === config.value.environment;
            await saveGitConfig(tx, config.value, stays);
            if (!stays) {
                await forgetReconcile(tx);
            }
            return stays;
        });
        return success({ config: config.value, on });
    }
}

export type AccessCheck = { step: 'read' | 'write'; ok: boolean; message: string };

export type AccessTestResult = { ok: boolean; checks: AccessCheck[]; topology: TopologyView | null; note: string };

const ACCESS_NOTE =
    'The test proves the token can read and write the repository, not whether a given branch is protected: the provider decides that at each push.';

const reason = (e: unknown) => (e instanceof GitError ? e.message : (e as Error).message);

export class TestGitAccessHandler implements UseCaseHandler<AccessTestResult> {
    constructor(private readonly options: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<AccessTestResult>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const config = await validConfig(input, ctx, this.options);
        if (!config.ok) {
            return config;
        }

        const access = await gitAccess(ctx, config.value);
        if (!access.ok) {
            return access;
        }

        try {
            return success(
                await withThrowawayClone(this.options.clonesDir, access.value, remote => testAccess(remote, config.value.environment)),
            );
        } catch (e) {
            return fail('unavailable', `The clone could not be made: ${reason(e)}`);
        }
    }
}

async function testAccess(remote: GitRemote, environment: string): Promise<AccessTestResult> {
    const checks: AccessCheck[] = [];
    const result = (topology: TopologyView | null) => ({ ok: checks.every(c => c.ok), checks, topology, note: ACCESS_NOTE });

    let branches: Map<string, string>;
    try {
        branches = await remote.branches();
        checks.push({
            step: 'read',
            ok: true,
            message: `Reached the repository: ${branches.size} ${branches.size === 1 ? 'branch' : 'branches'}.`,
        });
    } catch (e) {
        checks.push({ step: 'read', ok: false, message: `Could not read the repository: ${reason(e)}` });
        return result(null);
    }

    const branch = `flowtinus/access-check-${crypto.randomUUID().slice(0, 8)}`;
    // an empty repository's first branch becomes its default, which GitLab and GitHub refuse to delete: a dry run
    // still opens a push, where the server checks the token may write, and leaves the repository empty
    if (branches.size === 0) {
        try {
            await remote.pushDryRun(await remote.commit({ parent: null, changes: {}, message: 'Flowtinus access check' }), branch);
            checks.push({ step: 'write', ok: true, message: 'The repository is empty: a push was accepted without creating a branch.' });
        } catch (e) {
            checks.push({ step: 'write', ok: false, message: `Could not push to the repository: ${reason(e)}` });
        }

        return result(await readTopology(remote, environment, branches).catch(() => null));
    }

    try {
        await remote.push(await remote.commit({ parent: null, changes: {}, message: 'Flowtinus access check' }), branch, null);
    } catch (e) {
        checks.push({ step: 'write', ok: false, message: `Could not push the branch ${branch}: ${reason(e)}` });
        return result(await readTopology(remote, environment, branches).catch(() => null));
    }

    try {
        await remote.deleteBranch(branch);
        checks.push({ step: 'write', ok: true, message: `Pushed and deleted the branch ${branch}.` });
    } catch (e) {
        checks.push({
            step: 'write',
            ok: true,
            message: `Pushed the branch ${branch}, but could not delete it (delete it by hand): ${reason(e)}`,
        });
    }

    return result(await readTopology(remote, environment, branches).catch(() => null));
}

export async function onWorkspaceRepository<T>(
    ctx: UseCaseContext,
    options: GitOptions,
    work: (remote: GitRemote, config: GitConfig) => Promise<UseCaseResult<T>>,
): Promise<UseCaseResult<T>> {
    const config = await readGitConfig(ctx.db, ctx.workspaceId);
    if (!config) {
        return fail('conflict', 'This workspace has no git configuration.');
    }

    const access = await gitAccess(ctx, config);
    if (!access.ok) {
        return access;
    }

    try {
        return await withWorkspaceClone(options.clonesDir, ctx.workspaceId, access.value, remote => work(remote, config));
    } catch (e) {
        if (e instanceof GitError) {
            return fail('unavailable', `The repository answered: ${e.message}`);
        }

        throw e;
    }
}

export class GetTopologyHandler implements UseCaseHandler<{ topology: TopologyView }> {
    constructor(private readonly options: GitOptions) {}

    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ topology: TopologyView }>> {
        return (
            requireRole(ctx, 'viewer') ??
            onWorkspaceRepository(ctx, this.options, async (remote, config) =>
                success({ topology: await readTopology(remote, config.environment) }),
            )
        );
    }
}

export const CreateTopologyCommand = z.object({
    confirm: z.literal(true, 'Confirm creating the branch'),
    label: z.string().trim().min(1).max(40).optional(),
    branch: z
        .string()
        .trim()
        .superRefine((value, ctx) => {
            const error = branchNameError(value);
            if (error) {
                ctx.addIssue({ code: 'custom', message: error });
            }
        })
        .optional(),
});

export class CreateTopologyHandler implements UseCaseHandler<{ topology: TopologyView }> {
    constructor(private readonly options: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ topology: TopologyView }>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const parsed = validate(CreateTopologyCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        return onWorkspaceRepository(ctx, this.options, async (remote, config) => {
            if ((await remote.branches()).has(CONFIG_BRANCH)) {
                return fail('conflict', `The repository already has ${CONFIG_BRANCH}.`);
            }

            const environment: EnvironmentDecl = {
                env: config.environment,
                label: parsed.value.label ?? config.environment,
                branch: parsed.value.branch ?? config.environment.toLowerCase(),
                promotesTo: [],
                mode: 'direct',
            };
            const commit = await remote.commit({
                parent: null,
                changes: { [TOPOLOGY_FILE]: topologyYaml([environment]) },
                message: `Topology: ${environment.env}`,
                author: await gitAuthorOf(ctx),
            });
            await remote.push(commit, CONFIG_BRANCH, null);
            return success({ topology: await readTopology(remote, config.environment) });
        });
    }
}

export class GetTurnOnPlanHandler implements UseCaseHandler<TurnOnPlan> {
    constructor(private readonly options: GitOptions) {}

    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<TurnOnPlan>> {
        return requireRole(ctx, 'admin') ?? onWorkspaceRepository(ctx, this.options, (remote, config) => turnOnPlan(ctx, remote, config));
    }
}

export const TurnGitOnCommand = z.object({
    createBranch: z.boolean().optional(),
    choice: z.enum(['git', 'server'], 'git or server').optional(),
});

export type TurnOnResult = { outcome: TurnOnOutcome; branch: string; warnings: TreeIssue[] };

export class TurnGitOnHandler implements UseCaseHandler<TurnOnResult> {
    constructor(private readonly options: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<TurnOnResult>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const parsed = validate(TurnGitOnCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const turned = await onWorkspaceRepository(ctx, this.options, (remote, config) => turnGitOn(ctx, remote, config, parsed.value));
        if (turned.ok) {
            await ensureHookToken(ctx);
        }
        return turned;
    }
}

export class RenewHookTokenHandler implements UseCaseHandler<{ hook: string }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ hook: string }>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }
        if (!(await readGitState(ctx.db, ctx.workspaceId))?.on) {
            return fail('conflict', 'Git is off in this workspace.');
        }

        return success({ hook: hookPath(await workspaceHandle(ctx), await renewHookToken(ctx)) });
    }
}

export class RemoveGitConfigHandler implements UseCaseHandler<{ config: null }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ config: null }>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        await ctx.db.transaction(async db => {
            const tx = { ...ctx, db };
            // waits for a running reconcile, which would write the deployed set after it is forgotten
            await lockReconcile(db, ctx.workspaceId);
            await removeGitConfig(tx);
            await forgetReconcile(tx);
            await forgetHookToken(tx);
        });
        return success({ config: null });
    }
}

export class ReconcileHandler implements UseCaseHandler<ReconcileResult> {
    constructor(private readonly options: GitOptions) {}

    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ReconcileResult>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const result = await onWorkspaceRepository(ctx, this.options, (remote, config) => fetchAndReconcile(ctx, remote, config));
        // Reconcile now is a fetch like a poll's: what it found is what the git section shows (another one running is not)
        if (
            (result.ok || result.error.message !== 'A reconcile of this workspace is already running.') &&
            (await readGitState(ctx.db, ctx.workspaceId))?.on
        ) {
            await recordPoll(ctx.db, ctx.workspaceId, new Date(), result.ok ? undefined : result.error.message);
        }
        return result;
    }
}

export type GitCommitView = { sha: string; message?: string; author?: string; at?: string };

/**
 * What the git section and the sidebar show with git on: the commit the deploy is on, a commit git is at that was
 * refused (with its errors per file), git unreachable (since when), and the warnings of the commit applied.
 */
export type GitStatusView =
    | { on: false }
    | {
          on: true;
          branch: string | null;
          /** the environment's mode in the topology: not direct, the tree's changes come only from git */
          mode: Mode;
          deploy: GitCommitView | null;
          refused: (GitCommitView & { errors: TreeIssue[]; refusedAt: string }) | null;
          unreachable: { since: string; error: string } | null;
          warnings: TreeIssue[];
          lastPoll: LastPoll | null;
      };

export class GetGitStatusHandler implements UseCaseHandler<GitStatusView> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<GitStatusView>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }
        if (!(await readGitState(ctx.db, ctx.workspaceId))?.on) {
            return success({ on: false });
        }

        const state = await readState(ctx.db, ctx.workspaceId);
        const shas = [state.applied, state.refused?.commit].filter((sha): sha is string => !!sha);
        const commits = await ctx.db.query<{ sha: string; message: string; author_name: string; authored_at: Date }>(
            'SELECT sha, message, author_name, authored_at FROM git_commits WHERE workspace_id = $1 AND sha = ANY($2::text[])',
            [ctx.workspaceId, shas],
        );
        const commit = (sha: string): GitCommitView => {
            const row = commits.find(c => c.sha === sha);
            return row ? { sha, message: row.message, author: row.author_name, at: new Date(row.authored_at).toISOString() } : { sha };
        };
        const lastPoll = await readLastPoll(ctx.db, ctx.workspaceId);
        return success({
            on: true,
            branch: state.branch ?? null,
            mode: state.mode ?? 'direct',
            deploy: state.applied ? commit(state.applied) : null,
            refused: state.refused ? { ...commit(state.refused.commit), errors: state.refused.errors, refusedAt: state.refused.at } : null,
            unreachable: lastPoll?.error ? { since: lastPoll.since ?? lastPoll.at, error: lastPoll.error } : null,
            warnings: state.warnings ?? [],
            lastPoll,
        });
    }
}
