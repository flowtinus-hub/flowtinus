import type { Database } from '#shared/database/database';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { workspaces } from './workspace';
import { workspaceMembers, type WorkspaceRole } from './workspace-member';

export type Membership = { workspaceId: string; slug: string; name: string; role: WorkspaceRole };

export async function membershipsOf(db: Database, userId: string): Promise<Membership[]> {
    return db.orm
        .select({ workspaceId: workspaces.id, slug: workspaces.slug, name: workspaces.name, role: workspaceMembers.role })
        .from(workspaceMembers)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
        .where(and(sql`${workspaceMembers.userId}::text = ${userId}`, isNull(workspaces.deletedAt)))
        .orderBy(sql`lower(${workspaces.name})`, asc(workspaces.slug));
}
