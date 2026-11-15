import { withUpdatedByName } from '#features/users/user-names';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { toConnectionView, type ConnectionView } from '../connection';
import { ConnectionRepository } from '../connection-store';

export class ListConnectionsHandler implements UseCaseHandler<{ items: (ConnectionView & { updatedByName?: string })[] }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ items: (ConnectionView & { updatedByName?: string })[] }>> {
        const rows = await new ConnectionRepository(ctx.db, ctx.workspaceId).all();
        return success({ items: await withUpdatedByName(ctx.db, rows.map(toConnectionView)) });
    }
}
