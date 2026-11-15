import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { FlowRepository } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { flows } from '../flow';
import { readDraft, type FlowDraft } from '../flow-draft';

export const GetDraftQuery = z.object({ id: z.uuid('Invalid') });

export class GetDraftHandler implements UseCaseHandler<FlowDraft> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowDraft>> {
        const parsed = validate(GetDraftQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const [flow] = await new FlowRepository(ctx.db, ctx.workspaceId).findAll(eq(flows.id, parsed.value.id));
        return flow ? success(readDraft(flow)) : fail('not-found', 'Flow not found.');
    }
}
