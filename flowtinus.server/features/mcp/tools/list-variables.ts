import { asc, eq } from 'drizzle-orm';
import { variables } from '#features/variables/variable';
import { defineTool, ok, workspaceArg } from './tool';

export const listVariables = defineTool({
    name: 'list_variables',
    scope: 'resources:read',
    description:
        "A workspace's variables (shared by all its projects; $VARIABLES.<name> in expressions, VARIABLES in scripts): name and value.",
    input: { workspace: workspaceArg },
    run: async (_args, t) => {
        const rows = await t.ctx.db.orm
            .select({ name: variables.name, value: variables.value })
            .from(variables)
            .where(eq(variables.workspaceId, t.ctx.workspaceId))
            .orderBy(asc(variables.name));
        return ok({ variables: rows });
    },
});
