import { createMiddleware } from 'hono/factory';
import { refuseOnLocalServer } from '#features/git/local-server';
import { toHttpError } from '#shared/use-cases/to-http-result';
import type { AppEnv } from '../app-env';

export const offOnLocalServer = (what: string) =>
    createMiddleware<AppEnv>(async (c, next) => {
        const refused = refuseOnLocalServer(c.get('useCase').git, what);
        if (refused && !refused.ok) {
            return toHttpError(c, refused.error);
        }
        await next();
    });
