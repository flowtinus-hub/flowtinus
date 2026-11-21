import type { Database } from '#shared/database/database';
import { listFlowSchedules, type ScheduleView } from '#features/schedules/schedules';
import { listFlowWebhooks, type WebhookView } from '#features/webhooks/webhooks';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';

export type ArrivedDisabled = { flowId: string; flowName: string; projectId: string; schedules: ScheduleView[]; webhooks: WebhookView[] };

export async function listArrivedDisabled(db: Database, workspaceId: string): Promise<ArrivedDisabled[]> {
    const flows = await db.query<{ id: string; name: string; project_id: string }>(
        `SELECT f.id, f.name, f.project_id FROM flows f WHERE f.workspace_id = $1 AND f.deleted_at IS NULL
         AND (EXISTS (SELECT 1 FROM flow_schedules s WHERE s.flow_id = f.id AND s.arrived_disabled AND s.archived_at IS NULL)
           OR EXISTS (SELECT 1 FROM flow_webhooks w WHERE w.flow_id = f.id AND w.arrived_disabled AND w.archived_at IS NULL))
       ORDER BY f.name, f.id`,
        [workspaceId],
    );
    const items: ArrivedDisabled[] = [];
    for (const flow of flows) {
        const [schedules, webhooks] = await Promise.all([
            listFlowSchedules(db, workspaceId, flow.id),
            listFlowWebhooks(db, workspaceId, flow.id),
        ]);
        items.push({
            flowId: flow.id,
            flowName: flow.name,
            projectId: flow.project_id,
            schedules: schedules.filter(s => s.arrivedDisabled),
            webhooks: webhooks.filter(w => w.arrivedDisabled),
        });
    }
    return items;
}

export function arrivedSince(before: ArrivedDisabled[], after: ArrivedDisabled[]): ArrivedDisabled[] {
    const waiting = new Set(before.flatMap(item => [...item.schedules, ...item.webhooks].map(t => t.id)));
    return after
        .map(item => ({
            ...item,
            schedules: item.schedules.filter(s => !waiting.has(s.id)),
            webhooks: item.webhooks.filter(w => !waiting.has(w.id)),
        }))
        .filter(item => item.schedules.length > 0 || item.webhooks.length > 0);
}

export class ListArrivedDisabledHandler implements UseCaseHandler<{ items: ArrivedDisabled[] }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ items: ArrivedDisabled[] }>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }
        return success({ items: await listArrivedDisabled(ctx.db, ctx.workspaceId) });
    }
}
