import { createMiddleware } from 'hono/factory';
import type { Keyring } from '#shared/crypto/keyring';
import type { Database } from '#shared/database/database';
import type { GitOptions } from '#features/git/git-config';
import type { AppEnv } from '../app-env';
import { findApiToken } from '#features/api-tokens/api-tokens';

// TODO: AUTH!
/** PLACEHOLDER until authentication exists: the user comes from the X-User-Id header. */
export const requestContext = (db: Database, keyring?: Keyring, git?: GitOptions) =>
    createMiddleware<AppEnv>(async (c, next) => {
        // PROTOTYPE (#86): the VS Code extension calls the editor's routes with a personal access token
        const bearer = /^Bearer\s+(\S+)$/i.exec((c.req.header('authorization') ?? '').trim())?.[1];
        if (bearer) {
            const owner = await findApiToken(db, bearer);
            if (!owner) {
                return c.json({ error: { code: 'unauthenticated', message: 'The token is unknown, revoked or expired.' } }, 401);
            }
            c.set('useCase', { workspaceId: '', userId: owner.userId, db, keyring, git });
            c.set('scopes', owner.scopes);
            c.set('runScope', owner.runScope);
            await next();
            return;
        }

        const userId = c.req.header('x-user-id') ?? '';
        if (!userId) {
            return c.json({ error: { code: 'unauthenticated', message: 'Missing X-User-Id.' } }, 401);
        }

        c.set('useCase', { workspaceId: '', userId, db, keyring, git });
        await next();
    });
