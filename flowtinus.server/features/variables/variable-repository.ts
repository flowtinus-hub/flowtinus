import type { Database } from '#shared/database/database';
import { WorkspaceRepository } from '#shared/database/repository';
import { variables, type Variable } from './variable';

export class VariableRepository extends WorkspaceRepository<typeof variables> {
    constructor(db: Database, workspaceId: string) {
        super(db, variables, workspaceId);
    }

    async all(): Promise<Variable[]> {
        return (await this.findMany()).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    }
}
