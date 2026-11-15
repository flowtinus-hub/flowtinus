import { type AnyPgColumn, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from '#features/workspaces/workspace';
import { projects } from '#features/projects/project';

export const folders = pgTable('folders', {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id),
    projectId: uuid('project_id')
        .notNull()
        .references(() => projects.id),
    parentId: uuid('parent_id').references((): AnyPgColumn => folders.id),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by'),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: text('removed_by'),
});

export type Folder = typeof folders.$inferSelect;
