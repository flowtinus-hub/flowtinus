import { listWorkers, type WorkersView } from '#features/supervisors/supervisors';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { success, type UseCaseResult } from '#shared/use-cases/use-case-result';

export class ListSupervisorsHandler implements UseCaseHandler<WorkersView> {
    constructor(private readonly environment: string) {}

    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<WorkersView>> {
        return success(await listWorkers(ctx.db, this.environment));
    }
}
