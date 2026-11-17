import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { secrets } from '#features/secrets/secret';
import { users } from '#features/users/user';
import { deleteWorkspaceSetting, readWorkspaceSetting, writeWorkspaceSetting } from '#features/workspaces/workspace-settings';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import type { GitAccess, GitAuthor } from './git-remote';
import { ENVIRONMENT_NAME } from './topology';

export const GIT_SETTING = 'git';

export type GitConfig = { repository: string; tokenSecret: string; environment: string };

export type GitOptions = {
    clonesDir: string;
    allowFileUrls: boolean;
};

export const gitOptions = (environment: string, options: Partial<GitOptions> = {}): GitOptions => ({
    clonesDir: options.clonesDir ?? join(tmpdir(), 'flowtinus-git'),
    allowFileUrls: options.allowFileUrls ?? environment === 'DEV',
});

function repositoryError(value: string, allowFileUrls: boolean): string | null {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return 'An HTTP(S) URL (SSH comes later)';
    }
    if (!['http:', 'https:', ...(allowFileUrls ? ['file:'] : [])].includes(url.protocol)) {
        return 'An HTTP(S) URL (SSH comes later)';
    }

    return url.username || url.password ? 'Without credentials: the token goes in the secret' : null;
}

export const gitConfigSchema = (options: GitOptions) =>
    z.object({
        repository: z
            .string('Required')
            .trim()
            .max(500, 'At most 500 characters')
            .superRefine((value, ctx) => {
                const error = repositoryError(value, options.allowFileUrls);
                if (error) {
                    ctx.addIssue({ code: 'custom', message: error });
                }
            }),
        tokenSecret: z.string('Required').trim().min(1, 'Required'),
        environment: z.string('Required').trim().regex(ENVIRONMENT_NAME, 'Letters, digits, - and _ (1 to 40)'),
    });

const storedConfig = z.object({ repository: z.string(), tokenSecret: z.string(), environment: z.string(), on: z.boolean().optional() });

export async function readGitState(db: Database, workspaceId: string): Promise<{ config: GitConfig; on: boolean } | null> {
    const parsed = storedConfig.safeParse(await readWorkspaceSetting(db, workspaceId, GIT_SETTING));
    if (!parsed.success) {
        return null;
    }

    const { on, ...config } = parsed.data;
    return { config, on: on ?? false };
}

export const readGitConfig = async (db: Database, workspaceId: string) => (await readGitState(db, workspaceId))?.config ?? null;

export const isGitOn = async (db: Database, workspaceId: string) => (await readGitState(db, workspaceId))?.on ?? false;

export const saveGitConfig = (ctx: UseCaseContext, config: GitConfig, on: boolean) =>
    writeWorkspaceSetting(ctx.db, ctx.workspaceId, GIT_SETTING, { ...config, on }, ctx.userId);

export const removeGitConfig = (ctx: UseCaseContext) => deleteWorkspaceSetting(ctx.db, ctx.workspaceId, GIT_SETTING);

export async function findTokenSecret(ctx: UseCaseContext, name: string) {
    const [secret] = await ctx.db.orm
        .select()
        .from(secrets)
        .where(sql`${secrets.workspaceId} = ${ctx.workspaceId} AND lower(${secrets.name}) = lower(${name})`);
    return secret ?? null;
}

export async function gitAccess(ctx: UseCaseContext, config: GitConfig): Promise<UseCaseResult<GitAccess>> {
    const secret = await findTokenSecret(ctx, config.tokenSecret);
    if (!secret) {
        return fail('conflict', `The secret ${config.tokenSecret} that holds the token no longer exists.`);
    }
    if (!ctx.keyring) {
        return fail('unavailable', 'No keyring: the token cannot be read.');
    }

    try {
        return success({ repository: config.repository, token: await ctx.keyring.decrypt(secret, secret.id, secret.name) });
    } catch (e) {
        return fail('unavailable', `The token in the secret ${secret.name} cannot be decrypted: ${(e as Error).message}`);
    }
}

export async function gitAuthorOf(ctx: UseCaseContext): Promise<GitAuthor | undefined> {
    const [user] = await ctx.db.orm
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(sql`${users.id}::text = ${ctx.userId}`);
    return user;
}
