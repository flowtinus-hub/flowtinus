import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** The handle (unique, never changed) is what the urls carry (/w/<handle>/...). */
export const workspaces = pgTable('workspaces', {
    id: uuid('id').primaryKey(),
    handle: text('handle').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    icon: text('icon').notNull().default('layers'),
    color: text('color').notNull().default('blue'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by'),
});

export type Workspace = typeof workspaces.$inferSelect;
