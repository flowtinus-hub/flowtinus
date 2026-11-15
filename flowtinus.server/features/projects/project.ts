import { workspaces } from '#features/workspaces/workspace';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const projects = pgTable('projects', {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id),
    name: text('name').notNull(),
    description: text('description').notNull(),
    icon: text('icon').notNull().default('folder'),
    color: text('color').notNull().default('blue'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by'),
});

export type Project = typeof projects.$inferSelect;
