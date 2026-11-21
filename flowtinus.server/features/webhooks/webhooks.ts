import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DEFAULT_WEBHOOK_RESPONSE, WEBHOOK_RESPONSES, type WebhookResponse } from '@flowtinus/core';
import type { Database } from '#shared/database/database';
import { withUpdatedByName } from '#features/users/user-names';

export const WebhookFieldsInput = z.object({
    name: z.string().trim().min(1, 'Required').max(80, 'At most 80 characters'),
    enabled: z.boolean().default(true),
    response: z.enum(WEBHOOK_RESPONSES).default(DEFAULT_WEBHOOK_RESPONSE),
});

export type WebhookFields = z.infer<typeof WebhookFieldsInput>;

export type WebhookView = {
    id: string;
    flowId: string;
    path: string;
    name: string;
    enabled: boolean;
    arrivedDisabled: boolean;
    response: WebhookResponse;
    tokenHint: string | null;
    last: { at: Date; status: number; runId?: string } | null;
    createdAt: Date;
    updatedBy: string | null;
    updatedByName?: string;
};

export function newToken(): { token: string; hash: string; hint: string } {
    const token = `dfwh_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
    return { token, hash: hashToken(token), hint: token.slice(0, 9) };
}

export const webhookPath = (id: string) => `wh/${id}`;

export const hashToken = (token: string) => new Bun.CryptoHasher('sha256').update(token).digest('hex');

export function tokenMatches(given: string, hash: string): boolean {
    const a = Buffer.from(hashToken(given), 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
}

type Row = {
    id: string;
    flow_id: string;
    name: string;
    enabled: boolean;
    arrived_disabled: boolean;
    response: WebhookResponse;
    token_hint: string | null;
    last_called_at: Date | null;
    last_status: number | null;
    last_run_id: string | null;
    created_at: Date;
    updated_by: string | null;
};

const SELECT = `SELECT w.id, w.flow_id, w.name, w.enabled, w.arrived_disabled, w.response, w.token_hint, w.last_called_at, w.last_status,
       w.last_run_id, w.created_at, w.updated_by
  FROM flow_webhooks w`;

const toView = (row: Row): WebhookView => ({
    id: row.id,
    flowId: row.flow_id,
    path: webhookPath(row.id),
    name: row.name,
    enabled: row.enabled,
    arrivedDisabled: row.arrived_disabled,
    response: row.response,
    tokenHint: row.token_hint,
    last:
        row.last_called_at && row.last_status !== null
            ? { at: new Date(row.last_called_at), status: row.last_status, ...(row.last_run_id ? { runId: row.last_run_id } : {}) }
            : null,
    createdAt: new Date(row.created_at),
    updatedBy: row.updated_by,
});

export async function listFlowWebhooks(db: Database, workspaceId: string, flowId: string): Promise<WebhookView[]> {
    const rows = await db.query<Row>(
        `${SELECT} WHERE w.workspace_id = $1 AND w.flow_id = $2 AND w.archived_at IS NULL ORDER BY w.created_at, w.id`,
        [workspaceId, flowId],
    );
    return withUpdatedByName(db, rows.map(toView));
}

export async function findWebhook(db: Database, workspaceId: string, id: string): Promise<WebhookView | null> {
    const [row] = await db.query<Row>(`${SELECT} WHERE w.workspace_id = $1 AND w.id = $2 AND w.archived_at IS NULL`, [workspaceId, id]);
    return row ? (await withUpdatedByName(db, [toView(row)]))[0]! : null;
}

export async function switchWebhook(
    db: Database,
    ctx: { workspaceId: string; userId: string },
    id: string,
    enabled: boolean,
): Promise<{ token?: string }> {
    const minted = enabled ? newToken() : null;
    const [row] = await db.query<{ minted: boolean }>(
        `UPDATE flow_webhooks SET enabled = $3, arrived_disabled = arrived_disabled AND NOT $3, token_hash = coalesce(token_hash, $4),
       token_hint = coalesce(token_hint, $5), updated_by = $6, updated_at = now()
     FROM (SELECT token_hash IS NULL AS minted FROM flow_webhooks WHERE workspace_id = $1 AND id = $2) was
     WHERE workspace_id = $1 AND id = $2 RETURNING was.minted`,
        [ctx.workspaceId, id, enabled, minted?.hash ?? null, minted?.hint ?? null, ctx.userId],
    );
    return minted && row?.minted ? { token: minted.token } : {};
}

export async function webhookCounts(
    db: Database,
    workspaceId: string,
    projectId: string,
): Promise<Map<string, { total: number; on: number }>> {
    const rows = await db.query<{ flow_id: string; total: number | string; on: number | string }>(
        `SELECT flow_id, count(*) AS total, count(*) FILTER (WHERE enabled) AS "on" FROM flow_webhooks
     WHERE workspace_id = $1 AND project_id = $2 AND archived_at IS NULL GROUP BY flow_id`,
        [workspaceId, projectId],
    );
    return new Map(rows.map(r => [r.flow_id, { total: Number(r.total), on: Number(r.on) }]));
}
