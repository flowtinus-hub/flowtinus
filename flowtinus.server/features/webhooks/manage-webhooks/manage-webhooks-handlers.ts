import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { activeFlow, refuseUndeployed } from '#features/deployments/deployments';
import { refuseTriggerTables } from '#features/git/git-config';
import { flows } from '#features/flows/flow';
import { FlowRepository } from '#features/folders/project-tree';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { findWebhook, listFlowWebhooks, newToken, switchWebhook, WebhookFieldsInput, type WebhookView } from '../webhooks';

const Id = z.object({ id: z.uuid('Invalid') });

export class ListWebhooksHandler implements UseCaseHandler<{ items: WebhookView[] }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ items: WebhookView[] }>> {
        const parsed = validate(Id, input);
        if (!parsed.ok) {
            return parsed;
        }

        const [row] = await new FlowRepository(ctx.db, ctx.workspaceId).findAll(eq(flows.id, parsed.value.id));
        return row ? success({ items: await listFlowWebhooks(ctx.db, ctx.workspaceId, row.id) }) : fail('not-found', 'Flow not found.');
    }
}

export class CreateWebhookHandler implements UseCaseHandler<{ webhook: WebhookView; token: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ webhook: WebhookView; token: string }>> {
        const denied = requireRole(ctx, 'editor') ?? (await refuseTriggerTables(ctx.db, ctx.workspaceId));
        if (denied) {
            return denied;
        }

        const parsed = validate(z.object({ flowId: z.uuid('Invalid'), fields: WebhookFieldsInput }), input);
        if (!parsed.ok) {
            return parsed;
        }

        const flow = await activeFlow(ctx, parsed.value.flowId);
        if (!flow) {
            return fail('not-found', 'Flow not found.');
        }

        const undeployed = await refuseUndeployed(ctx.db, ctx.workspaceId, flow.id, 'webhook');
        if (undeployed) {
            return undeployed;
        }

        const { name, enabled, response } = parsed.value.fields;
        const id = crypto.randomUUID();
        const { token, hash, hint } = newToken();
        await ctx.db.query(
            `INSERT INTO flow_webhooks (id, workspace_id, project_id, flow_id, name, enabled, response, token_hash, token_hint, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
            [id, ctx.workspaceId, flow.projectId, flow.id, name, enabled, response, hash, hint, ctx.userId],
        );
        return success({ webhook: (await findWebhook(ctx.db, ctx.workspaceId, id))!, token });
    }
}

export class UpdateWebhookHandler implements UseCaseHandler<{ webhook: WebhookView; token?: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ webhook: WebhookView; token?: string }>> {
        const denied = requireRole(ctx, 'editor') ?? (await refuseTriggerTables(ctx.db, ctx.workspaceId));
        if (denied) {
            return denied;
        }

        const parsed = validate(z.object({ id: z.uuid('Invalid'), fields: WebhookFieldsInput }), input);
        if (!parsed.ok) {
            return parsed;
        }

        const { name, enabled, response } = parsed.value.fields;
        const [updated] = await ctx.db.query<{ id: string }>(
            `UPDATE flow_webhooks SET name = $3, response = $4, updated_by = $5, updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL RETURNING id`,
            [ctx.workspaceId, parsed.value.id, name, response, ctx.userId],
        );
        if (!updated) {
            return fail('not-found', 'Webhook not found.');
        }

        const minted = await switchWebhook(ctx.db, ctx, updated.id, enabled);
        return success({ webhook: (await findWebhook(ctx.db, ctx.workspaceId, updated.id))!, ...minted });
    }
}

export class SwitchWebhookHandler implements UseCaseHandler<{ webhook: WebhookView; token?: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ webhook: WebhookView; token?: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(z.object({ id: z.uuid('Invalid'), enabled: z.boolean() }), input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id, enabled } = parsed.value;
        const webhook = await findWebhook(ctx.db, ctx.workspaceId, id);
        if (!webhook) {
            return fail('not-found', 'Webhook not found.');
        }
        const undeployed = enabled && (await refuseUndeployed(ctx.db, ctx.workspaceId, webhook.flowId, 'webhook'));
        if (undeployed) {
            return undeployed;
        }

        const minted = await switchWebhook(ctx.db, ctx, id, enabled);
        return success({ webhook: (await findWebhook(ctx.db, ctx.workspaceId, id))!, ...minted });
    }
}

/** A new token for a webhook: the old one stops working at once; the new one is answered this once. */
export class NewWebhookTokenHandler implements UseCaseHandler<{ webhook: WebhookView; token: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ webhook: WebhookView; token: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(Id, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { token, hash, hint } = newToken();
        const [updated] = await ctx.db.query<{ id: string }>(
            `UPDATE flow_webhooks SET token_hash = $3, token_hint = $4, updated_by = $5, updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL RETURNING id`,
            [ctx.workspaceId, parsed.value.id, hash, hint, ctx.userId],
        );
        return updated
            ? success({ webhook: (await findWebhook(ctx.db, ctx.workspaceId, updated.id))!, token })
            : fail('not-found', 'Webhook not found.');
    }
}

export class DeleteWebhookHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor') ?? (await refuseTriggerTables(ctx.db, ctx.workspaceId));
        if (denied) {
            return denied;
        }

        const parsed = validate(Id, input);
        if (!parsed.ok) {
            return parsed;
        }

        const [deleted] = await ctx.db.query('DELETE FROM flow_webhooks WHERE workspace_id = $1 AND id = $2 RETURNING id', [
            ctx.workspaceId,
            parsed.value.id,
        ]);
        return deleted ? success({ id: parsed.value.id }) : fail('not-found', 'Webhook not found.');
    }
}
