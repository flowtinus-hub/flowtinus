import { z } from 'zod';
import { secretNameError, secretValueError } from '@flowtinus/core';
import { fieldErrors } from '#shared/use-cases/field-errors';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { insertSecret, workspaceSecrets } from '../secret-store';

export const CreateSecretCommand = z.object({ name: z.string().trim(), value: z.string() });

export class CreateSecretHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(CreateSecretCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { name, value } = parsed.value;
        const invalid = fieldErrors({
            name: secretNameError(name, await workspaceSecrets(ctx.db, ctx.workspaceId)),
            value: secretValueError(value),
        });
        if (invalid) {
            return invalid;
        }

        const secret = await insertSecret(ctx.db, ctx, name, value);
        return success({ id: secret.id });
    }
}
