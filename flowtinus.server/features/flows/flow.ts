import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { folders } from '#features/folders/folder';
import { workspaces } from '#features/workspaces/workspace';
import { projects } from '#features/projects/project';

/**
 * Follows migrations/1_initial.sql. name and folder_id are metadata of the row, never part of
 * flow_versions (definition, content_hash): renaming or moving a flow keeps its id and touches no version, deployment
 * or deployment history, so it needs no deploy.
 */
export const flows = pgTable('flows', {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id),
    projectId: uuid('project_id')
        .notNull()
        .references(() => projects.id),
    folderId: uuid('folder_id').references(() => folders.id),
    name: text('name').notNull(),
    workerTag: text('worker_tag').notNull().default('default'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by'),
    deletedByCommit: text('deleted_by_commit'),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: text('removed_by'),
});

export type Flow = typeof flows.$inferSelect;
