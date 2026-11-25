import { z } from 'zod';
import { lockReconcile } from '#features/git/reconcile';
import type { FlowFile } from '@flowtinus/core';
import type { Flow } from '#features/flows/flow';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseError, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { authorizeFlowCommand, type FlowAccess } from './authorize-flow-command';
import { emergencyRollbackChecks, type CheckedVersion, type EmergencyRollbackChecks } from './emergency-rollback-checks';
import { hasGitContent } from './emergency-rollback-content';
import { currentDeployment, emergencyRollbackOf, endEmergencyRollback, loadDeployments, lockFlowDeployments, setDeployed, versionDefinition, type DeployedVersion, type EmergencyRollback, type FlowDeploymentsView } from '../deployments';

export const EmergencyRollbackCommand = z.object({ id: z.uuid('Invalid'), versionId: z.uuid('Invalid') });

export const EndEmergencyRollbackCommand = z.object({ id: z.uuid('Invalid') });

// who rolls back follows what the mode reviews: an editor in direct, an admin where the rollback skips a review
const ROLLBACK_ACCESS: FlowAccess = {
    role: mode => (mode === 'direct' ? 'editor' : 'admin'),
    gitOff: 'Git is off in this workspace: roll back by deploying an older version.',
};

type Locked = { current: DeployedVersion | null; rollback: EmergencyRollback | null };

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

const goBackToGit = (db: Database, ctx: UseCaseContext, flowId: string, rollback: EmergencyRollback) =>
    endEmergencyRollback(db, ctx, flowId, { backToGit: rollback.git });

type VersionThatRan = { id: string; number: number; content_hash: string; definition: FlowFile };

async function loadVersionThatRan(ctx: UseCaseContext, flow: Flow, versionId: string): Promise<UseCaseResult<VersionThatRan>> {
    const [version] = await ctx.db.query<VersionThatRan & { ran: boolean }>(
        `SELECT v.id, v.number, v.content_hash, v.definition,
         EXISTS (SELECT 1 FROM deployment_history h WHERE h.flow_id = v.flow_id AND h.to_version_id = v.id) AS ran
       FROM flow_versions v WHERE v.workspace_id = $1 AND v.flow_id = $2 AND v.id = $3`,
        [ctx.workspaceId, flow.id, versionId],
    );
    if (!version) {
        return fail('not-found', 'Version not found.');
    }
    if (!version.ran) {
        return fail('validation', `v${version.number} never ran here: an emergency rollback goes back to a version that ran here.`);
    }
    return success(version);
}

const checkedVersion = async (db: Database, version: DeployedVersion): Promise<CheckedVersion> => ({
    number: version.number,
    definition: await versionDefinition(db, version.id),
});

// back to git's content (the end of the rollback) or to the version that runs: nothing to check
async function checksOf(
    ctx: UseCaseContext,
    flow: Flow,
    version: VersionThatRan,
    { current, rollback }: Locked,
): Promise<EmergencyRollbackChecks> {
    const git = rollback?.git ?? current;
    if (!current || !git || current.id === version.id || hasGitContent({ git }, version.content_hash)) {
        return { errors: [], warnings: [] };
    }

    const [running, gitVersion] = await Promise.all([checkedVersion(ctx.db, current), checkedVersion(ctx.db, git)]);
    return emergencyRollbackChecks(ctx, flow, version, running, gitVersion);
}

export class EmergencyRollbackChecksHandler implements UseCaseHandler<EmergencyRollbackChecks> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<EmergencyRollbackChecks>> {
        const found = await authorizeFlowCommand(input, EmergencyRollbackCommand, ctx, ROLLBACK_ACCESS);
        if (!found.ok) {
            return found;
        }

        const { flow, command } = found.value;
        const version = await loadVersionThatRan(ctx, flow, command.versionId);
        if (!version.ok) {
            return version;
        }

        const [current, rollback] = await Promise.all([
            currentDeployment(ctx.db, ctx.workspaceId, flow.id),
            emergencyRollbackOf(ctx.db, ctx.workspaceId, flow.id),
        ]);
        return success(await checksOf(ctx, flow, version.value, { current, rollback }));
    }
}

export class EmergencyRollbackHandler implements UseCaseHandler<FlowDeploymentsView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowDeploymentsView>> {
        const found = await authorizeFlowCommand(input, EmergencyRollbackCommand, ctx, ROLLBACK_ACCESS);
        if (!found.ok) {
            return found;
        }

        const { flow, command } = found.value;
        const loaded = await loadVersionThatRan(ctx, flow, command.versionId);
        if (!loaded.ok) {
            return loaded;
        }

        const version = loaded.value;
        return underLocks(ctx, flow, async (db, locked) => {
            const { current, rollback } = locked;
            if (!current) {
                return { code: 'conflict', message: `${flow.name} is not deployed: there is nothing to roll back.` };
            }
            if (current.id === version.id) {
                return { code: 'validation', message: `v${version.number} is the version that runs.` };
            }

            const git = rollback?.git ?? current;
            if (hasGitContent({ git }, version.content_hash)) {
                if (!rollback) {
                    return { code: 'validation', message: `v${version.number} has the content of the version that runs.` };
                }
                await goBackToGit(db, ctx, flow.id, rollback);
                return null;
            }

            const { errors } = await checksOf({ ...ctx, db }, flow, version, locked);
            if (errors.length > 0) {
                return { code: 'validation', message: errors.join(' ') };
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

export class EndEmergencyRollbackHandler implements UseCaseHandler<FlowDeploymentsView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowDeploymentsView>> {
        const found = await authorizeFlowCommand(input, EndEmergencyRollbackCommand, ctx, ROLLBACK_ACCESS);
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
