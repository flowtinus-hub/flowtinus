import { MAX_PINNED_BYTES, type EnvelopeData, type FlowFile } from '@flowtinus/core';
import type { Database } from '#shared/database/database';
import { pgJson } from '#shared/database/jsonb';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';

/*
 * Pinned outputs are the user's (table pins): per user, flow and node, never in the draft nor in git, the same on every
 * branch. A test run replays its user's pins; a run for real never has any.
 */

export type Pinned = Record<string, EnvelopeData[]>;
export type Pins = Record<string, Pinned>;

export async function pinsOf(db: Database, workspaceId: string, userId: string, flowId: string): Promise<Pins> {
    const rows = await db.query<{ node_id: string; pinned: Pinned }>(
        'SELECT node_id, pinned FROM pins WHERE workspace_id = $1 AND user_id = $2 AND flow_id = $3 ORDER BY node_id',
        [workspaceId, userId, flowId],
    );
    return Object.fromEntries(rows.map(r => [r.node_id, r.pinned]));
}

/** the file with these pins on its nodes (a pin of a node the file no longer has is left out) */
export const withPins = (file: FlowFile, pins: Pins): FlowFile => ({
    ...file,
    nodes: file.nodes.map(({ pinned: _pinned, ...n }) => (pins[n.id] ? { ...n, pinned: pins[n.id] } : n)),
});

export const withoutPinned = (file: FlowFile): FlowFile => withPins(file, {});

const bytesOf = (pinned: Pinned) => JSON.stringify(pinned).length;

/** pins (or replaces) the node's output for the user, refused past MAX_PINNED_BYTES for the user's pins on the flow */
export async function setPin(
    ctx: UseCaseContext,
    flowId: string,
    nodeId: string,
    pinned: Pinned,
): Promise<UseCaseResult<{ nodeId: string }>> {
    return ctx.db.transaction(async db => {
        await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pins:${ctx.workspaceId}:${ctx.userId}:${flowId}`]);
        const others = Object.entries(await pinsOf(db, ctx.workspaceId, ctx.userId, flowId)).filter(([id]) => id !== nodeId);
        const bytes = others.reduce((n, [, p]) => n + bytesOf(p), bytesOf(pinned));
        if (bytes > MAX_PINNED_BYTES) {
            return fail(
                'validation',
                `The pinned outputs take ${(bytes / 1024 ** 2).toFixed(1)} MB (at most ${MAX_PINNED_BYTES / 1024 ** 2} MB): unpin a component.`,
            );
        }

        await db.query(
            `INSERT INTO pins (workspace_id, user_id, flow_id, node_id, pinned) VALUES ($1, $2, $3, $4, $5::text::jsonb)
       ON CONFLICT (workspace_id, user_id, flow_id, node_id) DO UPDATE SET pinned = EXCLUDED.pinned, updated_at = now()`,
            [ctx.workspaceId, ctx.userId, flowId, nodeId, pgJson(pinned)],
        );
        return success({ nodeId });
    });
}

/** takes the user's pins off these nodes: the ones that had one */
export async function removePins(ctx: UseCaseContext, flowId: string, nodeIds: string[]): Promise<string[]> {
    const rows = await ctx.db.query<{ node_id: string }>(
        'DELETE FROM pins WHERE workspace_id = $1 AND user_id = $2 AND flow_id = $3 AND node_id = ANY($4::text[]) RETURNING node_id',
        [ctx.workspaceId, ctx.userId, flowId, nodeIds],
    );
    return rows.map(r => r.node_id);
}
