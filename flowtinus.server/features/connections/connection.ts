import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { ConnectionServer } from '@flowtinus/core';
import { jsonb } from '#shared/database/jsonb';
import { workspaces } from '#features/workspaces/workspace';

/** The config's sensitive fields name secrets of the workspace, never a value. `server`: what its last successful test found. */
export const connections = pgTable('connections', {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id),
    name: text('name').notNull(),
    type: text('type').notNull(),
    config: jsonb('config').$type<Record<string, string>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    server: jsonb('server').$type<ConnectionServer>(),
});

export type Connection = typeof connections.$inferSelect;

export type ConnectionView = Omit<Connection, 'workspaceId'>;

export const toConnectionView = ({ workspaceId: _workspaceId, ...connection }: Connection): ConnectionView => connection;
