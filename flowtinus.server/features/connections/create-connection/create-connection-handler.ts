import { z } from 'zod';
import { workBranch } from '#features/git/branch-read';
import { createConnectionOnBranch } from '#features/git/branch-edits';
import { changeTree } from '#features/git/git-first';
import { insertSecret } from '#features/secrets/secret-store';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { checkProfile, ConnectionRepository, ProfileInput, usedSecrets } from '../connection-store';

export const CreateConnectionCommand = z.object(ProfileInput);

/**
 * A new connection profile of the workspace, with the secrets typed in its form ("+ New"): all checked first,
 * then written in one transaction, so a failure leaves neither the profile nor its new secrets.
 */
export class CreateConnectionHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(CreateConnectionCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const branch = await workBranch(ctx);
        if (branch) {
            return createConnectionOnBranch(ctx, branch, parsed.value);
        }
        const { newSecrets, ...fields } = parsed.value;
        const checked = await checkProfile(ctx, fields, newSecrets);
        if ('failure' in checked) {
            return checked.failure;
        }

        const id = crypto.randomUUID();
        await changeTree(ctx, async tx => {
            for (const secret of usedSecrets(checked.value, newSecrets)) {
                await insertSecret(tx, ctx, secret.name, secret.value);
            }

            await new ConnectionRepository(tx, ctx.workspaceId).insert({ id, ...checked.value, updatedBy: ctx.userId });
        });

        return success({ id });
    }
}
