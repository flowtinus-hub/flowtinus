import { z } from 'zod';
import { secretNameError, variableValueError } from '@flowtinus/core';
import { fieldErrors } from '#shared/use-cases/field-errors';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { VariableRepository } from '../variable-repository';

export const CreateVariableCommand = z.object({ name: z.string().trim(), value: z.string() });

/**
 * A new variable of the workspace (for all its projects). Names follow the secrets' rule (@flowtinus/core), unique among
 * the workspace's variables; a variable and a secret may share a name (VARIABLES and SECRETS are apart).
 */
export class CreateVariableHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(CreateVariableCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { name, value } = parsed.value;
        const repository = new VariableRepository(ctx.db, ctx.workspaceId);
        const invalid = fieldErrors({
            name: secretNameError(name, await repository.all()),
            value: variableValueError(value),
        });
        if (invalid) {
            return invalid;
        }

        const variable = await repository.insert({ id: crypto.randomUUID(), name, value, updatedBy: ctx.userId });
        return success({ id: variable.id });
    }
}
