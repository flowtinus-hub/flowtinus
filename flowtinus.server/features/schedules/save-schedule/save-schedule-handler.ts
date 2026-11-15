import { z } from 'zod';
import { activeFlow, currentDeployment } from '#features/deployments/deployments';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { ScheduleFieldsInput } from '../schedule-command';
import { findSchedule, saveSchedule, type ScheduleView } from '../schedules';

export const CreateScheduleCommand = z.object({ flowId: z.uuid('Invalid'), fields: ScheduleFieldsInput });
export const UpdateScheduleCommand = z.object({ id: z.uuid('Invalid'), fields: ScheduleFieldsInput });

export class SaveScheduleHandler implements UseCaseHandler<ScheduleView> {
    constructor(private readonly kind: 'create' | 'update') {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ScheduleView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = this.kind === 'create' ? validate(CreateScheduleCommand, input) : validate(UpdateScheduleCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const existing = 'id' in parsed.value ? await findSchedule(ctx.db, ctx.workspaceId, parsed.value.id) : null;
        if ('id' in parsed.value && !existing) {
            return fail('not-found', 'Schedule not found.');
        }

        const flowId = existing?.flowId ?? (parsed.value as { flowId: string }).flowId;
        const flow = await activeFlow(ctx, flowId);
        if (!flow) {
            return fail('not-found', 'Flow not found.');
        }

        const fields = { ...parsed.value.fields, parameters: parsed.value.fields.parameters ?? {} };
        if (fields.enabled && !(await currentDeployment(ctx.db, ctx.workspaceId, flow.id))) {
            return fail('validation', 'Deploy the flow first: only a deployed flow runs on a schedule.');
        }

        const id = existing?.id ?? crypto.randomUUID();
        await saveSchedule(ctx.db, ctx, { id, projectId: flow.projectId, flowId: flow.id, isNew: !existing }, fields);
        const saved = await findSchedule(ctx.db, ctx.workspaceId, id);
        return saved ? success(saved) : fail('not-found', 'Schedule not found.');
    }
}
