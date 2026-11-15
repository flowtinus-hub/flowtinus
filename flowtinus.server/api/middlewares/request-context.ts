import { createMiddleware } from 'hono/factory';
import type { Keyring } from '#shared/crypto/keyring';
import type { Database } from '#shared/database/database';
import type { AppEnv } from '../app-env';

// TODO: AUTH!
/** PLACEHOLDER until authentication exists: the user comes from the X-User-Id header. */
export const requestContext = (db: Database, keyring?: Keyring) =>
    createMiddleware<AppEnv>(async (c, next) => {
        const userId = c.req.header('x-user-id') ?? '';
        if (!userId) {
            return c.json({ error: { code: 'unauthenticated', message: 'Missing X-User-Id.' } }, 401);
        }

        c.set('useCase', { workspaceId: '', userId, db, keyring });
        await next();
    });
