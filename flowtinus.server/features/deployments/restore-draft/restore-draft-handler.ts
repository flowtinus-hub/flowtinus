import { z } from 'zod';
import type { FlowFile } from '@flowtinus/core';
import { writeDraft } from '#features/flows/flow-draft';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { activeFlow } from '../deployments';

export const RestoreDraftCommand = z.object({ id: z.uuid('Invalid'), versionId: z.uuid('Invalid') });

/**
 * Replaces an active flow's draft by one of its versions (the draft as it was is lost), at the next revision: an
 * editor still on the old one is told to reload. The flow's id and name stay the row's.
 */
export class RestoreDraftHandler implements UseCaseHandler<{ revision: number }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ revision: number }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(RestoreDraftCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const row = await activeFlow(ctx, parsed.value.id);
        if (!row) {
            return fail('not-found', 'Flow not found.');
        }

        const [version] = await ctx.db.query<{ definition: FlowFile }>(
            'SELECT definition FROM flow_versions WHERE workspace_id = $1 AND flow_id = $2 AND id = $3',
            [ctx.workspaceId, row.id, parsed.value.versionId],
        );
        if (!version) {
            return fail('not-found', 'Version not found.');
        }

        const revision = await ctx.db.transaction(db =>
            writeDraft(db, ctx.workspaceId, row, { ...version.definition, id: row.id, name: row.name }, ctx.userId),
        );
        return success({ revision: revision ?? 0 });
    }
}
