import { z } from 'zod';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { ENVIRONMENT_BRANCH } from './working-copy';

/** uncommitted: archived by a Delete here that is not committed yet (a Discard brings it back), not by git */
export type ArchivedConnection = {
    id: string;
    name: string;
    type: string;
    archivedAt: Date;
    archivedBy: string | null;
    archivedByName?: string;
    uncommitted: boolean;
};

export class ListArchivedConnectionsHandler implements UseCaseHandler<{ items: ArchivedConnection[] }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ items: ArchivedConnection[] }>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }

        const rows = await ctx.db.query<{
            id: string;
            name: string;
            type: string;
            deleted_at: Date;
            deleted_by: string | null;
            by_name: string | null;
            uncommitted: boolean;
        }>(
            `SELECT c.id, c.name, c.type, c.deleted_at, c.deleted_by, u.name AS by_name,
                EXISTS (SELECT 1 FROM working_copy w WHERE w.workspace_id = c.workspace_id AND w.branch = $2 AND w.file_id = c.id::text)
                  AS uncommitted
             FROM connections c LEFT JOIN users u ON u.id::text = c.deleted_by
             WHERE c.workspace_id = $1 AND c.deleted_at IS NOT NULL
             ORDER BY c.deleted_at DESC`,
            [ctx.workspaceId, ENVIRONMENT_BRANCH],
        );
        return success({
            items: rows.map(r => ({
                id: r.id,
                name: r.name,
                type: r.type,
                archivedAt: new Date(r.deleted_at),
                archivedBy: r.deleted_by,
                ...(r.by_name ? { archivedByName: r.by_name } : {}),
                uncommitted: r.uncommitted,
            })),
        });
    }
}

const DeleteArchivedInput = z.object({ id: z.uuid('Invalid') });

/** an archived connection deleted for good: its configuration goes; its secrets stay, as a Delete leaves them */
export class DeleteArchivedConnectionHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'admin');
        if (denied) {
            return denied;
        }
        const parsed = validate(DeleteArchivedInput, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id } = parsed.value;
        return ctx.db.transaction(async db => {
            const [row] = await db.query<{ uncommitted: boolean }>(
                `SELECT EXISTS (SELECT 1 FROM working_copy w WHERE w.workspace_id = c.workspace_id AND w.branch = $3 AND w.file_id = c.id::text)
                   AS uncommitted
                 FROM connections c WHERE c.workspace_id = $1 AND c.id = $2 AND c.deleted_at IS NOT NULL FOR UPDATE`,
                [ctx.workspaceId, id, ENVIRONMENT_BRANCH],
            );
            if (!row) {
                return fail('not-found', 'No archived connection has this id.');
            }
            if (row.uncommitted) {
                return fail('conflict', 'Its Delete is not committed yet: commit it, or discard it to bring the connection back.');
            }
            await db.query('DELETE FROM connections WHERE workspace_id = $1 AND id = $2', [ctx.workspaceId, id]);
            return success({ id });
        });
    }
}
