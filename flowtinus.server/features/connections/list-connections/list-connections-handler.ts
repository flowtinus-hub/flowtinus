import { branchConnections } from '#features/git/branch-edits';
import { workBranch } from '#features/git/branch-read';
import { withUpdatedByName } from '#features/users/user-names';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { toConnectionView, type ConnectionView } from '../connection';
import { ConnectionRepository } from '../connection-store';

export class ListConnectionsHandler implements UseCaseHandler<{ items: (ConnectionView & { updatedByName?: string })[] }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ items: (ConnectionView & { updatedByName?: string })[] }>> {
        const branch = await workBranch(ctx);
        const items = branch
            ? (await branchConnections(ctx, branch)).sort((a, b) => a.name.localeCompare(b.name, 'en'))
            : (await new ConnectionRepository(ctx.db, ctx.workspaceId).all()).map(toConnectionView);
        return success({ items: await withUpdatedByName(ctx.db, items) });
    }
}
