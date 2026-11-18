import { and, eq, sql } from 'drizzle-orm';
import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Database } from '#shared/database/database';
import { jsonb } from '#shared/database/jsonb';
import { workspaces } from './workspace';

export const workspaceSettings = pgTable(
    'workspace_settings',
    {
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id),
        key: text('key').notNull(),
        value: jsonb('value').notNull(),
        updatedBy: text('updated_by'),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    t => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

export async function readWorkspaceSetting(db: Database, workspaceId: string, key: string): Promise<unknown> {
    const [row] = await db.orm
        .select({ value: workspaceSettings.value })
        .from(workspaceSettings)
        .where(and(eq(workspaceSettings.workspaceId, workspaceId), eq(workspaceSettings.key, key)));
    return row?.value ?? null;
}

export async function writeWorkspaceSetting(db: Database, workspaceId: string, key: string, value: object, userId: string): Promise<void> {
    await db.orm
        .insert(workspaceSettings)
        .values({ workspaceId, key, value, updatedBy: userId })
        .onConflictDoUpdate({
            target: [workspaceSettings.workspaceId, workspaceSettings.key],
            set: { value, updatedBy: userId, updatedAt: sql`now()` },
        });
}

export async function deleteWorkspaceSetting(db: Database, workspaceId: string, key: string): Promise<void> {
    await db.orm.delete(workspaceSettings).where(and(eq(workspaceSettings.workspaceId, workspaceId), eq(workspaceSettings.key, key)));
}
