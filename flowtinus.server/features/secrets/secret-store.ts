import type { Database } from '#shared/database/database';
import { WorkspaceRepository } from '#shared/database/repository';
import { KeyringError } from '#shared/crypto/keyring';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { secrets, type Secret } from './secret';

/*
 * Reading and writing a workspace's secrets (for all its projects). A value goes in encrypted (ctx.keyring) and never comes back out through
 * the api: only the runner decrypts it, to run a flow.
 */

export class SecretRepository extends WorkspaceRepository<typeof secrets> {
    constructor(db: Database, workspaceId: string) {
        super(db, secrets, workspaceId);
    }
}

export const workspaceSecrets = (db: Database, workspaceId: string): Promise<Secret[]> => new SecretRepository(db, workspaceId).findMany();

function keyringOf(ctx: UseCaseContext) {
    if (!ctx.keyring) {
        throw new KeyringError('No keyring: secrets cannot be stored.');
    }

    return ctx.keyring;
}

export async function insertSecret(db: Database, ctx: UseCaseContext, name: string, value: string): Promise<Secret> {
    const id = crypto.randomUUID();
    const encrypted = await keyringOf(ctx).encrypt(value, id, name);
    return new SecretRepository(db, ctx.workspaceId).insert({ id, name, ...encrypted, updatedBy: ctx.userId });
}

export async function replaceSecretValue(ctx: UseCaseContext, secret: Secret, value: string): Promise<Secret | null> {
    const encrypted = await keyringOf(ctx).encrypt(value, secret.id, secret.name);
    return new SecretRepository(ctx.db, ctx.workspaceId).update(secret.id, { ...encrypted, updatedAt: new Date(), updatedBy: ctx.userId });
}
