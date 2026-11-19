import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { flows } from '#features/flows/flow';
import { FlowRepository, loadTree } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { isFolderVisible } from '@flowtinus/core';
import { loadDraft } from '#features/flows/flow-draft';
import { callsOf } from '#features/runs/start-run/called-flows';
import { deployedDefinitions, loadDeployments, type FlowDeploymentsView } from '../deployments';

export const GetDeploymentsQuery = z.object({ id: z.uuid('Invalid') });

export type DeploymentsWithWarnings = FlowDeploymentsView & {
    warnings: string[];
};

export class GetDeploymentsHandler implements UseCaseHandler<DeploymentsWithWarnings> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<DeploymentsWithWarnings>> {
        const parsed = validate(GetDeploymentsQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const [row] = await new FlowRepository(ctx.db, ctx.workspaceId).findAll(eq(flows.id, parsed.value.id));
        if (!row) {
            return fail('not-found', 'Flow not found.');
        }

        const tree = await loadTree(ctx.db, ctx.workspaceId, row.projectId);
        // the flows its Flow Invokers name (one named by expression cannot be known before it runs)
        const called = [...new Set(callsOf((await loadDraft(ctx.db, ctx.workspaceId, row)).flow))].filter(id => id !== row.id);
        const deployed = await deployedDefinitions(ctx.db, ctx.workspaceId, called);
        const warnings = called.flatMap(id => {
            const flow = tree.flows.find(f => f.id === id);
            if (!flow || flow.archivedAt || !isFolderVisible(tree.folders, flow.folderId)) {
                return [`It calls a flow that was archived or removed (${flow?.name ?? id}): those calls will fail.`];
            }

            return deployed.has(id) ? [] : [`It calls "${flow.name}", which is not deployed: those calls will fail.`];
        });
        return success({ ...(await loadDeployments(ctx.db, ctx.workspaceId, row.id)), warnings });
    }
}
