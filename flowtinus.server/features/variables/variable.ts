import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from '#features/workspaces/workspace';

export const variables = pgTable('variables', {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id),
    name: text('name').notNull(),
    value: text('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Variable = typeof variables.$inferSelect;

export type VariableView = Omit<Variable, 'workspaceId'>;

export const toVariableView = ({ workspaceId: _workspaceId, ...variable }: Variable): VariableView => variable;
