import { branchArchive, branchTree, workBranch } from '#features/git/branch-read';
import { z } from 'zod';
import { scheduleCounts } from '#features/schedules/schedules';
import { webhookCounts } from '#features/webhooks/webhooks';
import { withUpdatedByName } from '#features/users/user-names';
import { emergencyRollbackStates, type EmergencyRollbackState } from '#features/deployments/deployments';
import { GetProjectHandler } from '#features/projects/get-project/get-project-handler';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { loadTree, toFlowView, toFolderView, type FlowView, type FolderView } from '../project-tree';

export const GetProjectContentsQuery = z.object({ projectId: z.uuid('Invalid') });

export type ProjectContentsResponse = {
    folders: FolderView[];
    flows: (FlowView & {
        deployedVersion?: number | null;
        schedules?: { total: number; on: number } | null;
        /** with git on: deployedVersion runs here instead of git's version */
        emergencyRollback?: EmergencyRollbackState;
    })[];
};

export class GetProjectContentsHandler implements UseCaseHandler<ProjectContentsResponse> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ProjectContentsResponse>> {
        const parsed = validate(GetProjectContentsQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const project = await new GetProjectHandler().handle({ id: parsed.value.projectId }, ctx);
        if (!project.ok) {
            return project;
        }

        const branch = await workBranch(ctx);
        if (branch) {
            const tree = branchTree(branch, parsed.value.projectId);
            const archive = await branchArchive(ctx, branch);
            const inProject = <T extends { projectId: string }>(items: T[]) => items.filter(i => i.projectId === parsed.value.projectId);
            return success({
                folders: [...tree.folders, ...inProject(archive.folders)].map(toFolderView),
                flows: await withUpdatedByName(
                    ctx.db,
                    [...tree.flows, ...inProject(archive.flows)].map(flow => ({
                        ...toFlowView(flow),
                        ...(branch.editable ? {} : { readOnly: true as const }),
                    })),
                ),
            });
        }

        const tree = await loadTree(ctx.db, ctx.workspaceId, parsed.value.projectId);
        const deployed = await ctx.db.query<{ flow_id: string; number: number }>(
            `SELECT d.flow_id, v.number FROM deployments d JOIN flow_versions v ON v.id = d.flow_version_id
       JOIN flows f ON f.id = d.flow_id WHERE d.workspace_id = $1 AND f.project_id = $2`,
            [ctx.workspaceId, parsed.value.projectId],
        );
        const numbers = new Map(deployed.map(d => [d.flow_id, d.number]));
        const schedules = await scheduleCounts(ctx.db, ctx.workspaceId, parsed.value.projectId);
        const webhooks = await webhookCounts(ctx.db, ctx.workspaceId, parsed.value.projectId);
        const rollbacks = await emergencyRollbackStates(
            ctx.db,
            ctx.workspaceId,
            tree.flows.map(f => f.id),
        );
        return success({
            folders: tree.folders.map(toFolderView),
            flows: await withUpdatedByName(
                ctx.db,
                tree.flows.map(flow => ({
                    ...toFlowView(flow),
                    deployedVersion: numbers.get(flow.id) ?? null,
                    schedules: schedules.get(flow.id) ?? null,
                    webhooks: webhooks.get(flow.id) ?? null,
                    ...(rollbacks.has(flow.id) ? { emergencyRollback: rollbacks.get(flow.id)! } : {}),
                })),
            ),
        });
    }
}
