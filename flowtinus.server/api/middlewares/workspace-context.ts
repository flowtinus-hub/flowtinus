import { createMiddleware } from 'hono/factory';
import { and, eq, sql } from 'drizzle-orm';
import { workspaces } from '#features/workspaces/workspace';
import { workspaceMembers } from '#features/workspaces/workspace-member';
import type { AppEnv } from '../app-env';

export const workspaceContext = () =>
    createMiddleware<AppEnv>(async (c, next) => {
        const ctx = c.get('useCase');
        const handle = c.req.param('workspace') ?? '';
        const [row] = await ctx.db.orm
            .select({ id: workspaces.id, archived: sql<boolean>`${workspaces.deletedAt} IS NOT NULL`, role: workspaceMembers.role })
            .from(workspaces)
            .leftJoin(
                workspaceMembers,
                and(eq(workspaceMembers.workspaceId, workspaces.id), sql`${workspaceMembers.userId}::text = ${ctx.userId}`),
            )
            .where(eq(workspaces.handle, handle));
        const rest = c.req.path.slice(`/w/${handle}`.length);
        const archivedAllowed = rest === '' || rest === '/' || rest === '/restore';
        if (!row || (row.archived && !archivedAllowed)) {
            return c.json({ error: { code: 'not-found', message: `Workspace "${handle}" not found.` } }, 404);
        }

        if (!row.role) {
            return c.json({ error: { code: 'forbidden', message: 'You are not a member of this workspace.' } }, 403);
        }

        c.set('useCase', { ...ctx, workspaceId: row.id, role: row.role });
        await next();
    });
