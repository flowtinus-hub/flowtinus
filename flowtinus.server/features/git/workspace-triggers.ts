import { nextTime, type RepoSchedule, type RepoTriggers, type RepoWebhook } from '@flowtinus/core';
import { SCHEDULES_CHANNEL } from '#features/schedules/schedules';
import type { Database } from '#shared/database/database';
import { pgJson } from '#shared/database/jsonb';

export type FlowTriggers = { flowId: string } & RepoTriggers;

type Ctx = { workspaceId: string; userId: string };

export async function importTriggers(db: Database, ctx: Ctx, flows: FlowTriggers[]): Promise<void> {
    const projectOf = new Map(
        (
            await db.query<{ id: string; project_id: string }>(
                'SELECT id, project_id FROM flows WHERE workspace_id = $1 AND id = ANY($2::uuid[])',
                [ctx.workspaceId, flows.map(f => f.flowId)],
            )
        ).map(f => [f.id, f.project_id]),
    );
    const changed = new Set<string>();
    for (const { flowId, schedules, webhooks } of flows) {
        const place = { flowId, projectId: projectOf.get(flowId)! };
        for (const schedule of schedules) {
            if (await importSchedule(db, ctx, place, schedule)) {
                changed.add(flowId);
            }
        }
        for (const webhook of webhooks) {
            await importWebhook(db, ctx, place, webhook);
        }
    }

    const archived = await db.query<{ flow_id: string }>(
        `UPDATE flow_schedules SET archived_at = now(), enabled = false, next_fire_at = NULL, arrived_disabled = false, updated_by = $3, updated_at = now()
     WHERE workspace_id = $1 AND archived_at IS NULL AND NOT (id = ANY($2::uuid[])) RETURNING flow_id`,
        [ctx.workspaceId, flows.flatMap(f => f.schedules.map(s => s.id)), ctx.userId],
    );
    await db.query(
        `UPDATE flow_webhooks SET archived_at = now(), enabled = false, arrived_disabled = false, updated_by = $3, updated_at = now()
     WHERE workspace_id = $1 AND archived_at IS NULL AND NOT (id = ANY($2::uuid[]))`,
        [ctx.workspaceId, flows.flatMap(f => f.webhooks.map(w => w.id)), ctx.userId],
    );
    for (const flowId of new Set([...changed, ...archived.map(s => s.flow_id)])) {
        await db.notify(SCHEDULES_CHANNEL, flowId);
    }
}

type Place = { flowId: string; projectId: string };

async function importSchedule(db: Database, ctx: Ctx, place: Place, schedule: RepoSchedule): Promise<boolean> {
    const values = [
        schedule.id,
        ctx.workspaceId,
        place.projectId,
        place.flowId,
        schedule.cron,
        schedule.timezone,
        schedule.misfire,
        pgJson(schedule.parameters),
        schedule.input === undefined ? null : pgJson(schedule.input),
        ctx.userId,
    ];
    const [was] = await db.query<{ archived: boolean }>(
        'SELECT archived_at IS NOT NULL AS archived FROM flow_schedules WHERE workspace_id = $1 AND id = $2',
        [ctx.workspaceId, schedule.id],
    );
    if (!was) {
        await db.query(
            `INSERT INTO flow_schedules (id, workspace_id, project_id, flow_id, cron, timezone, misfire, parameters, input, enabled, arrived_disabled,
         created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb, false, true, $10, $10)`,
            values,
        );
        return false;
    }

    if (was.archived) {
        await db.query(
            `UPDATE flow_schedules SET project_id = $3, flow_id = $4, cron = $5, timezone = $6, misfire = $7, parameters = $8::text::jsonb,
         input = $9::text::jsonb, archived_at = NULL, enabled = false, next_fire_at = NULL, arrived_disabled = true, updated_by = $10, updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
            values,
        );
        return false;
    }

    const updated = await db.query(
        `UPDATE flow_schedules SET project_id = $3, flow_id = $4, cron = $5, timezone = $6, misfire = $7, parameters = $8::text::jsonb,
       input = $9::text::jsonb, next_fire_at = CASE WHEN enabled THEN $11::timestamptz END, last_error = NULL, updated_by = $10, updated_at = now()
     WHERE id = $1 AND workspace_id = $2
       AND (project_id, flow_id, cron, timezone, misfire, parameters, input) IS DISTINCT FROM ($3::uuid, $4::uuid, $5::text, $6::text, $7::text, $8::text::jsonb, $9::text::jsonb)
     RETURNING id`,
        [...values, nextTime(schedule.cron, schedule.timezone, new Date())],
    );
    return updated.length > 0;
}

async function importWebhook(db: Database, ctx: Ctx, place: Place, webhook: RepoWebhook): Promise<void> {
    const values = [webhook.id, ctx.workspaceId, place.projectId, place.flowId, webhook.name, webhook.response, ctx.userId];
    const [was] = await db.query<{ archived: boolean }>(
        'SELECT archived_at IS NOT NULL AS archived FROM flow_webhooks WHERE workspace_id = $1 AND id = $2',
        [ctx.workspaceId, webhook.id],
    );
    if (!was) {
        await db.query(
            `INSERT INTO flow_webhooks (id, workspace_id, project_id, flow_id, name, response, enabled, arrived_disabled, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, false, true, $7, $7)`,
            values,
        );
    } else if (was.archived) {
        await db.query(
            `UPDATE flow_webhooks SET project_id = $3, flow_id = $4, name = $5, response = $6, archived_at = NULL, enabled = false,
         arrived_disabled = true, updated_by = $7, updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
            values,
        );
    } else {
        await db.query(
            `UPDATE flow_webhooks SET project_id = $3, flow_id = $4, name = $5, response = $6, updated_by = $7, updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND (project_id, flow_id, name, response) IS DISTINCT FROM ($3::uuid, $4::uuid, $5::text, $6::text)`,
            values,
        );
    }
}
