import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    /** made from the email when the user is inserted (migration 10's trigger), never changed */
    handle: text('handle').notNull(),
    isAdmin: boolean('is_admin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
