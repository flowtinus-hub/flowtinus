import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { flows } from '#features/flows/flow';
import { projects } from '#features/projects/project';
import { hasLiveSupervisor, noSupervisorFor } from '#features/supervisors/supervisors';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { CHANNELS, findRun, notifyRunEvent } from '../run-queue';
import { emergencyRollbackRefusal, ranVersions } from './rollback-versions';

export const RerunRunCommand = z.object({ id: z.uuid('Invalid') });

export type RerunCheck = { leftByEmergencyRollback: { flowId: string; name: string; version: number }[] };

export class RerunCheckHandler implements UseCaseHandler<RerunCheck> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<RerunCheck>> {
        const parsed = validate(RerunRunCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const run = await findRun(ctx.db, parsed.value.id, ctx.workspaceId);
        if (!run || run.table !== 'runs') {
            return fail('not-found', 'Run not found.');
        }

        const ran = await ranVersions(ctx.db, ctx.workspaceId, run);
        return success({
            leftByEmergencyRollback: ran
                .filter(r => r.leftByEmergencyRollback && !r.deployed)
                .map(r => ({ flowId: r.flowId, name: r.name, version: r.number })),
        });
    }
}

/**
 * Re-run: queues a failed run (Runs page) again, the same thing: its snapshot as it was (the flow or deployed version,
 * the scripts, the called flows, the parameters and the input), its worker tag and priority. A new run of its own (a
 * call that failed comes back as a top run), started by who asked, with `rerun_of` pointing to the failed one. Only a
 * failed run for real of an active flow; refused while no live supervisor takes its tag (it would wait forever).
 */
export class RerunRunHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(RerunRunCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const run = await findRun(ctx.db, parsed.value.id, ctx.workspaceId);
        if (!run || run.table !== 'runs') {
            return fail('not-found', 'Run not found.');
        }

        if (run.status !== 'failed') {
            return fail('validation', 'Only a failed run can be run again.');
        }

        const [active] = await ctx.db.orm
            .select({ id: flows.id })
            .from(flows)
            .innerJoin(projects, eq(projects.id, flows.projectId))
            .where(
                and(eq(flows.id, run.flowId), eq(flows.workspaceId, ctx.workspaceId), isNull(flows.deletedAt), isNull(projects.deletedAt)),
            );
        if (!active) {
            return fail('validation', 'Its flow was archived or removed: it does not run anymore.');
        }

        const refusal = emergencyRollbackRefusal(await ranVersions(ctx.db, ctx.workspaceId, run));
        if (refusal) {
            return fail('conflict', refusal);
        }

        if (!(await hasLiveSupervisor(ctx.db, run.workerTag))) {
            return fail('unavailable', noSupervisorFor(run.workerTag));
        }

        const id = crypto.randomUUID();
        await ctx.db.query(
            `INSERT INTO runs (id, workspace_id, flow_id, project_id, mode, flow_version_id, draft_hash, status, trigger, worker_tag, priority,
         parameters, input, definition, scripts, called_flows, call_chain, flow_name, started_by, batch_size, rerun_of)
       SELECT $1, workspace_id, flow_id, project_id, mode, flow_version_id, draft_hash, 'queued', 'manual', worker_tag, priority,
         parameters, input, definition, scripts, called_flows, call_chain, flow_name, $3, batch_size, id
       FROM runs WHERE id = $2 AND workspace_id = $4`,
            [id, run.id, ctx.userId, ctx.workspaceId],
        );
        await notifyRunEvent(ctx.db, { id, type: 'status', workspaceId: ctx.workspaceId, rootId: id, status: 'queued' });
        await ctx.db.notify(CHANNELS.queued, run.workerTag);
        return success({ id });
    }
}
