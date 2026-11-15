import { createMiddleware } from 'hono/factory';
import type { WorkspaceRole } from '#features/workspaces/workspace-member';
import { membershipsOf } from '#features/workspaces/memberships';
import type { AppEnv } from '../app-env';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const runContext = () =>
    createMiddleware<AppEnv>(async (c, next) => {
        const ctx = c.get('useCase');
        const id = c.req.param('id') ?? '';
        if (!UUID.test(id)) {
            return next();
        }

        const [row] = await ctx.db.query<{ workspace_id: string; role: WorkspaceRole }>(
            `SELECT r.workspace_id, m.role
         FROM (SELECT workspace_id FROM runs WHERE id = $1 UNION ALL SELECT workspace_id FROM test_runs WHERE id = $1) r
         JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.user_id::text = $2
        LIMIT 1`,
            [id, ctx.userId],
        );
        if (!row) {
            return c.json({ error: { code: 'not-found', message: 'Run not found.' } }, 404);
        }

        c.set('useCase', { ...ctx, workspaceId: row.workspace_id, role: row.role });
        await next();
    });

export const memberWorkspaces = () =>
    createMiddleware<AppEnv>(async (c, next) => {
        const ctx = c.get('useCase');
        c.set('useCase', { ...ctx, workspaceIds: (await membershipsOf(ctx.db, ctx.userId)).map(m => m.workspaceId) });
        await next();
    });
