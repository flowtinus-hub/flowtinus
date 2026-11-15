import { Hono } from 'hono';
import { CreateApiTokenHandler, ListApiTokensHandler, RevokeApiTokenHandler } from '#features/api-tokens/manage-tokens/api-tokens-handlers';
import { toHttpResult } from '#shared/use-cases/to-http-result';
import type { AppEnv } from '../app-env';
import { jsonBody } from './request-input';

export function tokensRoutes() {
    return new Hono<AppEnv>()
        .get('/', async c => toHttpResult(c, await new ListApiTokensHandler().handle({}, c.get('useCase'))))
        .post('/', async c => toHttpResult(c, await new CreateApiTokenHandler().handle(await jsonBody(c), c.get('useCase')), 201))
        .post('/:id/revoke', async c =>
            toHttpResult(c, await new RevokeApiTokenHandler().handle({ id: c.req.param('id') }, c.get('useCase'))),
        );
}
