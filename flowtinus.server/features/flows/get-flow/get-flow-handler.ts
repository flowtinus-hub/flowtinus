import { branchFlow, workBranch } from '#features/git/branch-read';
import { gitBranch } from '#features/git/git-config';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { FlowRepository, toFlowView, type FlowView } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { flows } from '../flow';

export const GetFlowQuery = z.object({ id: z.uuid('Invalid') });

export class GetFlowHandler implements UseCaseHandler<FlowView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowView>> {
        const parsed = validate(GetFlowQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const branch = await workBranch(ctx);
        if (branch) {
            const found = branchFlow(branch, parsed.value.id);
            return found
                ? success({
                      ...toFlowView(found),
                      workBranch: true as const,
                      ...(branch.editable ? {} : { readOnly: true as const }),
                      ...(branch.removed ? { removedBranch: true as const } : {}),
                  })
                : fail('not-found', 'Flow not found.');
        }

        const [flow] = await new FlowRepository(ctx.db, ctx.workspaceId).findAll(eq(flows.id, parsed.value.id));
        if (!flow) {
            return fail('not-found', 'Flow not found.');
        }
        const offers = (await gitBranch(ctx.db, ctx.workspaceId))?.mode === 'pull-request';
        return success({ ...toFlowView(flow), ...(offers ? { offersBranch: true as const } : {}) });
    }
}
