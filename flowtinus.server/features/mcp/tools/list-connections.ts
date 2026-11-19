import { connectionServerWarning } from '@flowtinus/core';
import { asc, eq } from 'drizzle-orm';
import { connections } from '#features/connections/connection';
import { branchConnections } from '#features/git/branch-edits';
import { workBranch } from '#features/git/branch-read';
import { defineTool, ok, workspaceArg } from './tool';

export const listConnections = defineTool({
    name: 'list_connections',
    scope: 'resources:read',
    description:
        "A workspace's connection profiles (shared by all its projects): id (what a component's config.connection takes), name and type, and for a database the server its last successful test reached (engine, version, testedAt: test_connection updates it), with a warning when that server is another engine than the type (a Redshift connection that answers as PostgreSQL: write the SQL for the engine it really is). Never their fields.",
    input: { workspace: workspaceArg },
    run: async (_args, t) => {
        const branch = await workBranch(t.ctx);
        const rows = branch
            ? (await branchConnections(t.ctx, branch))
                  .map(({ id, name, type, server }) => ({ id, name, type, server }))
                  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            : await t.ctx.db.orm
                  .select({ id: connections.id, name: connections.name, type: connections.type, server: connections.server })
                  .from(connections)
                  .where(eq(connections.workspaceId, t.ctx.workspaceId))
                  .orderBy(asc(connections.name));
        return ok({
            connections: rows.map(({ server, ...row }) => {
                const warning = connectionServerWarning(row.type, server);
                return { ...row, ...(server ? { server } : {}), ...(warning ? { warning } : {}) };
            }),
        });
    },
});
