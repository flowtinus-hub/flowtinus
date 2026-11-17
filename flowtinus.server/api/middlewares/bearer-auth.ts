import { createMiddleware } from 'hono/factory';
import type { Keyring } from '#shared/crypto/keyring';
import type { Database } from '#shared/database/database';
import type { GitOptions } from '#features/git/git-config';
import { findApiToken } from '#features/api-tokens/api-tokens';
import type { AppEnv } from '../app-env';

export const bearerAuth = (db: Database, keyring?: Keyring, git?: GitOptions) =>
    createMiddleware<AppEnv>(async (c, next) => {
        const header = c.req.header('authorization') ?? '';
        const token = /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1];
        const owner = token ? await findApiToken(db, token) : null;
        if (!owner) {
            c.header('WWW-Authenticate', 'Bearer realm="flowtinus"');
            return c.json(
                {
                    error: {
                        code: 'unauthenticated',
                        message: token
                            ? 'The token is unknown, revoked or expired.'
                            : 'Missing personal access token (Authorization: Bearer ftn_...).',
                    },
                },
                401,
            );
        }

        // no workspace yet: each MCP call names the one it acts in (features/mcp/workspace-of-call.ts)
        c.set('useCase', { workspaceId: '', userId: owner.userId, db, keyring, git });
        c.set('scopes', owner.scopes);
        c.set('runScope', owner.runScope);
        await next();
    });
