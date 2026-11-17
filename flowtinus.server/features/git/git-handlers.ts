import { fieldErrors } from '#shared/use-cases/field-errors';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { z } from 'zod';
import { findTokenSecret, gitAccess, gitAuthorOf, gitConfigSchema, readGitConfig, removeGitConfig, saveGitConfig, type GitConfig, type GitOptions } from './git-config';
import { GitError, withThrowawayClone, withWorkspaceClone, type GitRemote } from './git-remote';
import { branchNameError, CONFIG_BRANCH, TOPOLOGY_FILE, topologyYaml, type EnvironmentDecl } from './topology';
import { readTopology, type TopologyView } from './workspace-topology';

export class GetGitConfigHandler implements UseCaseHandler<{ config: GitConfig | null }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ config: GitConfig | null }>> {
        return requireRole(ctx, 'viewer') ?? success({ config: await readGitConfig(ctx.db, ctx.workspaceId) });
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

export class SaveGitConfigHandler implements UseCaseHandler<{ config: GitConfig }> {
    constructor(private readonly options: GitOptions) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ config: GitConfig }>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        const config = await validConfig(input, ctx, this.options);
        if (!config.ok) {
            return config;
        }

        await saveGitConfig(ctx, config.value);
        return success({ config: config.value });
    }
}

export type AccessCheck = { step: 'read' | 'write'; ok: boolean; message: string };

export type AccessTestResult = { ok: boolean; checks: AccessCheck[]; topology: TopologyView | null; note: string };

const ACCESS_NOTE =
    'The test proves the token can read and write the repository, not whether a given branch is protected: the provider decides that at each push.';

const reason = (e: unknown) => (e instanceof GitError ? e.message : (e as Error).message);

/** the access of a configuration, saved or not: what it reads, a throwaway branch pushed and deleted, the topology */
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

        return success(
            await withThrowawayClone(this.options.clonesDir, access.value, remote => testAccess(remote, config.value.environment)),
        );
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

/** the saved configuration's repository, on the workspace's own clone; a git failure is the repository's answer */
async function onWorkspaceRepository<T>(
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

/** creates the topology branch, which must not exist yet, with this server's environment alone (direct) */
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

export class RemoveGitConfigHandler implements UseCaseHandler<{ config: null }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ config: null }>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }

        await removeGitConfig(ctx);
        return success({ config: null });
    }
}
