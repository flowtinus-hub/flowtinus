import { nextTime, type MisfireMode } from '@flowtinus/core';
import type { Database } from '#shared/database/database';
import { pgJson } from '#shared/database/jsonb';
import { withUpdatedByName } from '#features/users/user-names';

/*
 * A deployed flow's schedules (flow_schedules): a cron expression of 5 fields (minute hour day month
 * weekday) or 6 (with the second first), in an IANA time zone, computed by the core (the editor shows the same times).
 * next_fire_at is the next time it is due, null while it is off. The supervisors fire them (fire-schedules.ts).
 */

export const SCHEDULES_CHANNEL = 'schedules_changed';

export type LastFire = { at: Date; runId: string; status: string };

export type ScheduleOverrides = { cron?: string; timezone?: string; input?: unknown; noInput?: true; parameters: Record<string, string> };

export type ScheduleValues = { cron: string; timezone: string; parameters: Record<string, string>; input?: unknown };

export type ScheduleView = {
    id: string;
    flowId: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    arrivedDisabled: boolean;
    misfire: MisfireMode;
    parameters: Record<string, string>;
    input?: unknown;
    overrides: ScheduleOverrides;
    effective: ScheduleValues;
    nextFireAt: Date | null;
    last: LastFire | null;
    lastError: string | null;
    createdAt: Date;
    updatedBy: string | null;
    updatedByName?: string;
};

type Row = {
    id: string;
    flow_id: string;
    cron: string;
    timezone: string;
    enabled: boolean;
    arrived_disabled: boolean;
    misfire: MisfireMode;
    parameters: Record<string, string>;
    input: unknown;
    cron_override: string | null;
    timezone_override: string | null;
    input_override: { input?: unknown } | null;
    parameter_overrides: Record<string, string> | null;
    next_fire_at: Date | null;
    last_fired_at: Date | null;
    last_run_id: string | null;
    last_status: string | null;
    last_error: string | null;
    created_at: Date;
    updated_by: string | null;
};

const SELECT = `SELECT s.id, s.flow_id, s.cron, s.timezone, s.enabled, s.arrived_disabled, s.misfire, s.parameters, s.input, s.cron_override,
       s.timezone_override, s.input_override, s.parameter_overrides, s.next_fire_at, s.last_fired_at,
       s.last_run_id, r.status AS last_status, s.last_error, s.created_at, s.updated_by
  FROM flow_schedules s LEFT JOIN runs r ON r.id = s.last_run_id`;

const given = (value: unknown) => value !== null && value !== undefined;

export function effectiveValues(git: ScheduleValues, overrides: ScheduleOverrides): ScheduleValues {
    const input = overrides.noInput ? undefined : given(overrides.input) ? overrides.input : git.input;
    return {
        cron: overrides.cron ?? git.cron,
        timezone: overrides.timezone ?? git.timezone,
        parameters: { ...git.parameters, ...overrides.parameters },
        ...(given(input) ? { input } : {}),
    };
}

const inputOverride = (stored: Row['input_override']): Pick<ScheduleOverrides, 'input' | 'noInput'> =>
    stored === null ? {} : 'input' in stored ? { input: stored.input } : { noInput: true };

export const storedInputOverride = (overrides: ScheduleOverrides): string | null =>
    overrides.noInput ? '{}' : overrides.input === undefined ? null : pgJson({ input: overrides.input });

const toView = (row: Row): ScheduleView => {
    const git = { cron: row.cron, timezone: row.timezone, parameters: row.parameters ?? {}, input: row.input };
    const overrides: ScheduleOverrides = {
        ...(row.cron_override !== null ? { cron: row.cron_override } : {}),
        ...(row.timezone_override !== null ? { timezone: row.timezone_override } : {}),
        ...inputOverride(row.input_override),
        parameters: row.parameter_overrides ?? {},
    };
    return {
        id: row.id,
        flowId: row.flow_id,
        cron: row.cron,
        timezone: row.timezone,
        enabled: row.enabled,
        arrivedDisabled: row.arrived_disabled,
        misfire: row.misfire,
        parameters: git.parameters,
        ...(given(row.input) ? { input: row.input } : {}),
        overrides,
        effective: effectiveValues(git, overrides),
        nextFireAt: row.next_fire_at ? new Date(row.next_fire_at) : null,
        last:
            row.last_fired_at && row.last_run_id
                ? { at: new Date(row.last_fired_at), runId: row.last_run_id, status: row.last_status ?? 'queued' }
                : null,
        lastError: row.last_error,
        createdAt: new Date(row.created_at),
        updatedBy: row.updated_by,
    };
};

export const EFFECTIVE_COLUMNS = `coalesce(s.cron_override, s.cron) AS cron, coalesce(s.timezone_override, s.timezone) AS timezone,
       s.parameters || s.parameter_overrides AS parameters,
       CASE WHEN s.input_override IS NULL THEN s.input ELSE s.input_override -> 'input' END AS input`;

export async function foldOverrides(db: Database, workspaceId: string): Promise<void> {
    await db.query(
        `UPDATE flow_schedules SET cron = coalesce(cron_override, cron), timezone = coalesce(timezone_override, timezone),
       parameters = parameters || parameter_overrides,
       input = CASE WHEN input_override IS NULL THEN input ELSE input_override -> 'input' END,
       cron_override = NULL, timezone_override = NULL, input_override = NULL, parameter_overrides = '{}'::jsonb
     WHERE workspace_id = $1 AND (cron_override IS NOT NULL OR timezone_override IS NOT NULL OR input_override IS NOT NULL
       OR parameter_overrides <> '{}'::jsonb)`,
        [workspaceId],
    );
}

export async function listFlowSchedules(db: Database, workspaceId: string, flowId: string): Promise<ScheduleView[]> {
    const rows = await db.query<Row>(
        `${SELECT} WHERE s.workspace_id = $1 AND s.flow_id = $2 AND s.archived_at IS NULL ORDER BY s.created_at, s.id`,
        [workspaceId, flowId],
    );
    return withUpdatedByName(db, rows.map(toView));
}

export async function findSchedule(db: Database, workspaceId: string, id: string): Promise<(ScheduleView & { projectId: string }) | null> {
    const [row] = await db.query<Row & { project_id: string }>(
        `${SELECT.replace('SELECT s.id', 'SELECT s.project_id, s.id')} WHERE s.workspace_id = $1 AND s.id = $2 AND s.archived_at IS NULL`,
        [workspaceId, id],
    );
    return row ? { ...toView(row), projectId: row.project_id } : null;
}

export type ScheduleFields = Pick<ScheduleView, 'cron' | 'timezone' | 'enabled' | 'misfire' | 'parameters' | 'input'>;

export async function saveSchedule(
    db: Database,
    ctx: { workspaceId: string; userId: string },
    target: { id: string; projectId: string; flowId: string; isNew: boolean },
    fields: ScheduleFields,
): Promise<void> {
    const next = fields.enabled ? nextTime(fields.cron, fields.timezone, new Date()) : null;
    const values = [
        target.id,
        ctx.workspaceId,
        target.projectId,
        target.flowId,
        fields.cron.trim(),
        fields.timezone,
        fields.enabled,
        fields.misfire,
        pgJson(fields.parameters),
        fields.input === undefined ? null : pgJson(fields.input),
        next,
        ctx.userId,
    ];
    if (target.isNew) {
        await db.query(
            `INSERT INTO flow_schedules (id, workspace_id, project_id, flow_id, cron, timezone, enabled, misfire, parameters, input, next_fire_at,
         created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10::text::jsonb, $11, $12, $12)`,
            values,
        );
    } else {
        await db.query(
            `UPDATE flow_schedules SET cron = $5, timezone = $6, enabled = $7, misfire = $8, parameters = $9::text::jsonb,
         input = $10::text::jsonb, next_fire_at = $11, updated_by = $12, updated_at = now(), last_error = NULL,
         arrived_disabled = arrived_disabled AND NOT $7
       WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND flow_id = $4`,
            values,
        );
    }

    await db.notify(SCHEDULES_CHANNEL, target.flowId);
}

export async function scheduleCounts(
    db: Database,
    workspaceId: string,
    projectId: string,
): Promise<Map<string, { total: number; on: number }>> {
    const rows = await db.query<{ flow_id: string; total: number | string; on: number | string }>(
        `SELECT flow_id, count(*) AS total, count(*) FILTER (WHERE enabled) AS "on" FROM flow_schedules
     WHERE workspace_id = $1 AND project_id = $2 AND archived_at IS NULL GROUP BY flow_id`,
        [workspaceId, projectId],
    );
    return new Map(rows.map(r => [r.flow_id, { total: Number(r.total), on: Number(r.on) }]));
}
