import { z } from 'zod';
import { CreateVariableHandler } from '#features/variables/create-variable/create-variable-handler';
import { UpdateVariableHandler } from '#features/variables/update-variable/update-variable-handler';
import { VariableRepository } from '#features/variables/variable-repository';
import { defineTool, failed, ok, workspaceArg } from './tool';

export function variableOfName<V extends { id: string; name: string }>(variables: V[], name: string): V | undefined {
    const wanted = name.trim().toLowerCase();
    return variables.find(v => v.name.toLowerCase() === wanted);
}

export const setVariable = defineTool({
    name: 'set_variable',
    scope: 'resources:write',
    description:
        "Creates a variable of the workspace or changes its value (a plain value shared by all its projects; flows read it as $VARIABLES['name'], a component's connectionName can name a connection with it). Never a secret (a secret's value goes in through the editor only). A name is unique ignoring case: one that exists gets the new value (its name stays as it was). Changing a value changes every flow that reads it, from its next run: say so to the user. Answers created or updated, with the variable's name and value.",
    input: {
        workspace: workspaceArg,
        name: z.string().trim().min(1).max(64).describe('the variable name: a letter first, then letters, digits, - and _'),
        value: z.string().describe('its value (plain text, shown to whoever reads the workspace; never a password or a token)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async ({ name, value }, t) => {
        const existing = variableOfName(await new VariableRepository(t.ctx.db, t.ctx.workspaceId).all(), name);
        if (existing) {
            const updated = await new UpdateVariableHandler().handle({ id: existing.id, value }, t.ctx);
            return updated.ok ? ok({ updated: true, name: updated.value.name, value: updated.value.value }) : failed(updated.error);
        }
        const created = await new CreateVariableHandler().handle({ name, value }, t.ctx);
        return created.ok ? ok({ created: true, name, value }) : failed(created.error);
    },
});
