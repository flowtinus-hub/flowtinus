import { z } from 'zod';
import { changeTree } from '#features/git/git-first';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { ConnectionRepository } from '../connection-store';

export const DeleteConnectionCommand = z.object({ id: z.uuid('Invalid') });

/** Deletes a connection profile; its secrets stay (other profiles or flows may use them). */
export class DeleteConnectionHandler implements UseCaseHandler<{ id: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(DeleteConnectionCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id } = parsed.value;
        const name = (await new ConnectionRepository(ctx.db, ctx.workspaceId).findById(id))?.name ?? '';
        return (await changeTree(
            ctx,
            () => `Delete connection ${name}`,
            db => new ConnectionRepository(db, ctx.workspaceId).remove(id),
        ))
            ? success({ id })
            : fail('not-found', 'Connection not found.');
    }
}
