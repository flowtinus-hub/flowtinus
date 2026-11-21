import { handleHolder } from '@flowtinus/core';
import type { Database } from '#shared/database/database';
import { WorkspaceRepository } from '#shared/database/repository';
import { projects, type Project } from './project';

/**
 * Projects of ONE workspace: the workspaceId comes in the constructor and every query filters by it, so a repository
 * built for workspace A cannot see workspace B's projects. Archived (soft deleted) projects are left out unless a method says so.
 */
export class ProjectRepository extends WorkspaceRepository<typeof projects> {
    constructor(db: Database, workspaceId: string) {
        super(db, projects, workspaceId);
    }

    /** the project, archived ones included, that has the handle `name` makes */
    async handleHolder(name: string, exceptId?: string): Promise<Project | undefined> {
        return handleHolder(
            name,
            (await this.findAll()).filter(project => project.id !== exceptId),
        );
    }
}
