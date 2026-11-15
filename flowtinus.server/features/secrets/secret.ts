import { customType, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from '#features/workspaces/workspace';
import type { Bytes } from '#shared/crypto/keyring';

const bytea = customType<{ data: Bytes; driverData: Uint8Array }>({
    dataType: () => 'bytea',
    // PGlite and Bun's client give a Uint8Array (or a Buffer): copied into a plain one for WebCrypto
    fromDriver: value => new Uint8Array(value),
});

/** The value is only stored as AES-256-GCM ciphertext. */
export const secrets = pgTable('secrets', {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id),
    name: text('name').notNull(),
    keyVersion: text('key_version').notNull(),
    nonce: bytea('nonce').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Secret = typeof secrets.$inferSelect;

export type SecretView = { id: string; name: string; createdAt: Date; updatedAt: Date; updatedBy: string | null };

export const toSecretView = (secret: Secret): SecretView => ({
    id: secret.id,
    name: secret.name,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    updatedBy: secret.updatedBy,
});
