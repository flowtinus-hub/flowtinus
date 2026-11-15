import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from '#features/users/user';
import { workspaces } from './workspace';

/** what a member may do in a workspace: a viewer reads, an editor also changes, an admin also manages the workspace */
export const WORKSPACE_ROLES = ['viewer', 'editor', 'admin'] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const workspaceMembers = pgTable('workspace_members', {
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id),
    userId: uuid('user_id')
        .notNull()
        .references(() => users.id),
    role: text('role').$type<WorkspaceRole>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const roleAtLeast = (role: WorkspaceRole | undefined, required: WorkspaceRole): boolean =>
    role !== undefined && WORKSPACE_ROLES.indexOf(role) >= WORKSPACE_ROLES.indexOf(required);
