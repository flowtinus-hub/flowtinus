import { and, ne, sql } from 'drizzle-orm';
import type { Database } from '#shared/database/database';
import { WorkspaceRepository } from '#shared/database/repository';
import { projects } from './project';

/**
 * Projects of ONE workspace: the workspaceId comes in the constructor and every query filters by it, so a repository
 * built for workspace A cannot see workspace B's projects. Archived (soft deleted) projects are left out unless a method says so.
 */
export class ProjectRepository extends WorkspaceRepository<typeof projects> {
    constructor(db: Database, workspaceId: string) {
        super(db, projects, workspaceId);
    }

    existsByName(name: string, exceptId?: string): Promise<boolean> {
        const sameName = sql`lower(${projects.name}) = lower(${name})`;
        return this.exists(exceptId ? and(sameName, ne(projects.id, exceptId))! : sameName);
    }
}
