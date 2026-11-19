import { z } from 'zod';
import { secretNameError, secretValueError, validateProfile, type ProfileFields } from '@flowtinus/core';
import { workspaceSecrets } from '#features/secrets/secret-store';
import type { Database } from '#shared/database/database';
import { WorkspaceRepository } from '#shared/database/repository';
import { fieldErrors } from '#shared/use-cases/field-errors';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseResult } from '#shared/use-cases/use-case-result';
import { connections, type Connection } from './connection';

export class ConnectionRepository extends WorkspaceRepository<typeof connections> {
    constructor(db: Database, workspaceId: string) {
        super(db, connections, workspaceId);
    }

    async all(): Promise<Connection[]> {
        return (await this.findMany()).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    }
}

export const ProfileInput = {
    name: z.string(),
    type: z.string(),
    config: z.record(z.string(), z.string()),
    newSecrets: z.array(z.object({ name: z.string().trim(), value: z.string() })).default([]),
};

export async function checkProfile(
    ctx: UseCaseContext,
    fields: { name: string; type: string; config: Record<string, string> },
    newSecrets: { name: string; value: string }[],
    exceptId?: string,
    declared?: { id: string; name: string }[],
): Promise<{ value: ProfileFields } | { failure: UseCaseResult<never> }> {
    const existing = (await workspaceSecrets(ctx.db, ctx.workspaceId)).map(s => s.name);
    const errors: Record<string, string | undefined> = {};
    newSecrets.forEach((secret, i) => {
        const others = [...existing, ...newSecrets.slice(0, i).map(s => s.name)].map(name => ({ name }));
        const error = secretNameError(secret.name, others) ?? secretValueError(secret.value);
        if (error) {
            const field = Object.keys(fields.config).find(key => fields.config[key] === secret.name) ?? 'newSecrets';
            errors[field] = `Secret ${secret.name}: ${error}`;
        }
    });

    const others = (declared ?? (await new ConnectionRepository(ctx.db, ctx.workspaceId).all())).map(c => ({ id: c.id, name: c.name }));
    const profile = validateProfile(fields as ProfileFields, others, [...existing, ...newSecrets.map(s => s.name)], exceptId);
    const failure = fieldErrors({ ...profile.errors, ...errors });
    return failure ? { failure } : { value: profile.value };
}

export const usedSecrets = (profile: ProfileFields, newSecrets: { name: string; value: string }[]) => {
    const used = new Set(Object.values(profile.config));
    return newSecrets.filter(secret => used.has(secret.name));
};
