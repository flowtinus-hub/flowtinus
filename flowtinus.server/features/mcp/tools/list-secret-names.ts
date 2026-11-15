import { asc, eq } from 'drizzle-orm';
import { secrets } from '#features/secrets/secret';
import { defineTool, ok, workspaceArg } from './tool';

export const listSecretNames = defineTool({
    name: 'list_secret_names',
    scope: 'resources:read',
    description:
        "The names of a workspace's secrets (shared by all its projects; $SECRETS.<name>; a component's secret field takes the name). Never their values.",
    input: { workspace: workspaceArg },
    run: async (_args, t) => {
        const rows = await t.ctx.db.orm
            .select({ name: secrets.name })
            .from(secrets)
            .where(eq(secrets.workspaceId, t.ctx.workspaceId))
            .orderBy(asc(secrets.name));
        return ok({ secrets: rows.map(r => r.name) });
    },
});
