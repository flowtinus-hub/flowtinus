import { withUpdatedByName } from '#features/users/user-names';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { toVariableView, type VariableView } from '../variable';
import { VariableRepository } from '../variable-repository';

export class ListVariablesHandler implements UseCaseHandler<{ items: VariableView[] }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ items: VariableView[] }>> {
        const rows = await new VariableRepository(ctx.db, ctx.workspaceId).all();
        return success({ items: await withUpdatedByName(ctx.db, rows.map(toVariableView)) });
    }
}
