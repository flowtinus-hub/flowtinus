import { z } from 'zod';
import { mirrorGitChange } from '#features/git/git-mirror';
import { insertSecret } from '#features/secrets/secret-store';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { toConnectionView, type ConnectionView } from '../connection';
import { checkProfile, ConnectionRepository, ProfileInput, usedSecrets } from '../connection-store';

export const UpdateConnectionCommand = z.object({ id: z.uuid('Invalid'), ...ProfileInput });

export class UpdateConnectionHandler implements UseCaseHandler<ConnectionView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ConnectionView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(UpdateConnectionCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id, newSecrets, ...fields } = parsed.value;
        const current = await new ConnectionRepository(ctx.db, ctx.workspaceId).findById(id);
        if (!current) {
            return fail('not-found', 'Connection not found.');
        }

        const checked = await checkProfile(ctx, fields, newSecrets, id);
        if ('failure' in checked) {
            return checked.failure;
        }

        const updated = await mirrorGitChange(ctx, `Update connection ${checked.value.name}`, async tx => {
            for (const secret of usedSecrets(checked.value, newSecrets)) {
                await insertSecret(tx, ctx, secret.name, secret.value);
            }

            // another type or other fields may reach another server: what the last test found no longer holds
            const moved = current.type !== checked.value.type || JSON.stringify(current.config) !== JSON.stringify(checked.value.config);
            return new ConnectionRepository(tx, ctx.workspaceId).update(id, {
                ...checked.value,
                ...(moved ? { server: null } : {}),
                updatedAt: new Date(),
                updatedBy: ctx.userId,
            });
        });

        return updated ? success(toConnectionView(updated)) : fail('not-found', 'Connection not found.');
    }
}
