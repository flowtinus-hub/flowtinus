import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { flows } from '#features/flows/flow';
import { FlowRepository } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { listFlowSchedules, type ScheduleView } from '../schedules';

export const ListSchedulesQuery = z.object({ id: z.uuid('Invalid') });

export class ListSchedulesHandler implements UseCaseHandler<{ items: ScheduleView[] }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ items: ScheduleView[] }>> {
        const parsed = validate(ListSchedulesQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const [row] = await new FlowRepository(ctx.db, ctx.workspaceId).findAll(eq(flows.id, parsed.value.id));
        return row ? success({ items: await listFlowSchedules(ctx.db, ctx.workspaceId, row.id) }) : fail('not-found', 'Flow not found.');
    }
}
