import { z } from 'zod';
import { gitBranch } from '#features/git/git-config';
import { lockReconcile } from '#features/git/reconcile';
import type { Flow } from '#features/flows/flow';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseError, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { activeFlow, currentDeployment, emergencyRollbackOf, loadDeployments, lockFlowDeployments, setDeployed, type EmergencyRollback, type FlowDeploymentsView } from '../deployments';

export const EmergencyRollbackCommand = z.object({ id: z.uuid('Invalid'), versionId: z.uuid('Invalid') });

export const EndEmergencyRollbackCommand = z.object({ id: z.uuid('Invalid') });

type Current = { id: string; number: number; hash: string };

type Locked = { current: Current | null; rollback: EmergencyRollback | null };

/**
 * With git on, who rolls back follows what the mode reviews: an editor in direct, an admin where the rollback skips a
 * review. The mode is the last reconcile's, so that it works while git cannot be reached.
 */
async function onFlow<T extends { id: string }>(
    input: unknown,
    schema: z.ZodType<T>,
    ctx: UseCaseContext,
): Promise<UseCaseResult<{ flow: Flow; command: T }>> {
    const denied = requireRole(ctx, 'editor');
    if (denied) {
        return denied;
    }

    const parsed = validate(schema, input);
    if (!parsed.ok) {
        return parsed;
    }

    const git = await gitBranch(ctx.db, ctx.workspaceId);
    if (!git) {
        return fail('conflict', 'Git is off in this workspace: roll back by deploying an older version.');
    }

    const role = requireRole(ctx, git.mode === 'direct' ? 'editor' : 'admin');
    if (role) {
        return role;
    }

    const flow = await activeFlow(ctx, parsed.value.id);
    return flow ? success({ flow, command: parsed.value }) : fail('not-found', 'Flow not found.');
}

// git's version is read under the reconcile's locks: a commit applied meanwhile would leave it stale
async function underLocks(
    ctx: UseCaseContext,
    flow: Flow,
    change: (db: Database, locked: Locked) => Promise<UseCaseError | null>,
): Promise<UseCaseResult<FlowDeploymentsView>> {
    const refused = await ctx.db.transaction(async db => {
        await lockReconcile(db, ctx.workspaceId);
        await lockFlowDeployments(db, flow.id);
        const [current, rollback] = await Promise.all([
            currentDeployment(db, ctx.workspaceId, flow.id),
            emergencyRollbackOf(db, ctx.workspaceId, flow.id),
        ]);
        return change(db, { current, rollback });
    });
    if (refused) {
        return { ok: false, error: refused };
    }

    return success(await loadDeployments(ctx.db, ctx.workspaceId, flow.id));
}

async function goBackToGit(db: Database, ctx: UseCaseContext, flowId: string, rollback: EmergencyRollback): Promise<void> {
    await db.query('DELETE FROM emergency_rollbacks WHERE workspace_id = $1 AND flow_id = $2', [ctx.workspaceId, flowId]);
    await setDeployed(db, ctx, flowId, 'end-emergency-rollback', rollback.versionId, rollback.git.id);
}

/**
 * An emergency rollback: the environment runs a version of the flow that already ran here, other than the one running,
 * without git; git's version stays the one it replaced, through further rollbacks. A version with git's content ends it.
 */
export class EmergencyRollbackHandler implements UseCaseHandler<FlowDeploymentsView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowDeploymentsView>> {
        const found = await onFlow(input, EmergencyRollbackCommand, ctx);
        if (!found.ok) {
            return found;
        }

        const { flow, command } = found.value;
        const [version] = await ctx.db.query<{ id: string; number: number; content_hash: string; ran: boolean }>(
            `SELECT v.id, v.number, v.content_hash,
         EXISTS (SELECT 1 FROM deployment_history h WHERE h.flow_id = v.flow_id AND h.to_version_id = v.id) AS ran
       FROM flow_versions v WHERE v.workspace_id = $1 AND v.flow_id = $2 AND v.id = $3`,
            [ctx.workspaceId, flow.id, command.versionId],
        );
        if (!version) {
            return fail('not-found', 'Version not found.');
        }
        if (!version.ran) {
            return fail('validation', `v${version.number} never ran here: an emergency rollback goes back to a version that ran here.`);
        }

        return underLocks(ctx, flow, async (db, { current, rollback }) => {
            if (!current) {
                return { code: 'conflict', message: `${flow.name} is not deployed: there is nothing to roll back.` };
            }
            if (current.id === version.id) {
                return { code: 'validation', message: `v${version.number} is the version that runs.` };
            }

            const git = rollback?.git ?? current;
            if (version.content_hash === git.hash) {
                if (!rollback) {
                    return { code: 'validation', message: `v${version.number} has the content of the version that runs.` };
                }
                await goBackToGit(db, ctx, flow.id, rollback);
                return null;
            }

            await db.query(
                `INSERT INTO emergency_rollbacks (flow_id, workspace_id, git_version_id, version_id, by_user, at) VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (flow_id) DO UPDATE SET version_id = $4, by_user = $5, at = now()`,
                [flow.id, ctx.workspaceId, git.id, version.id, ctx.userId],
            );
            await setDeployed(db, ctx, flow.id, 'emergency-rollback', current.id, version.id);
            return null;
        });
    }
}

/** Ends an emergency rollback by hand: git's version runs again. */
export class EndEmergencyRollbackHandler implements UseCaseHandler<FlowDeploymentsView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowDeploymentsView>> {
        const found = await onFlow(input, EndEmergencyRollbackCommand, ctx);
        if (!found.ok) {
            return found;
        }

        const { flow } = found.value;

        return underLocks(ctx, flow, async (db, { rollback }) => {
            if (!rollback) {
                return { code: 'conflict', message: `${flow.name} is not in an emergency rollback.` };
            }
            await goBackToGit(db, ctx, flow.id, rollback);
            return null;
        });
    }
}
