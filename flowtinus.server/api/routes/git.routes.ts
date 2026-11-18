import { Hono } from 'hono';
import type { GitOptions } from '#features/git/git-config';
import { CreateTopologyHandler, GetGitConfigHandler, GetTopologyHandler, GetTurnOnPlanHandler, ReconcileHandler, RemoveGitConfigHandler, SaveGitConfigHandler, TestGitAccessHandler, TurnGitOnHandler } from '#features/git/git-handlers';
import { toHttpResult } from '#shared/use-cases/to-http-result';
import type { AppEnv } from '../app-env';
import { jsonBody } from './request-input';

export function gitRoutes(options: GitOptions) {
    return new Hono<AppEnv>()
        .get('/', async c => toHttpResult(c, await new GetGitConfigHandler().handle({}, c.get('useCase'))))
        .put('/', async c => toHttpResult(c, await new SaveGitConfigHandler(options).handle(await jsonBody(c), c.get('useCase'))))
        .post('/test', async c => toHttpResult(c, await new TestGitAccessHandler(options).handle(await jsonBody(c), c.get('useCase'))))
        .get('/topology', async c => toHttpResult(c, await new GetTopologyHandler(options).handle({}, c.get('useCase'))))
        .post('/topology', async c =>
            toHttpResult(c, await new CreateTopologyHandler(options).handle(await jsonBody(c), c.get('useCase')), 201),
        )
        .get('/on', async c => toHttpResult(c, await new GetTurnOnPlanHandler(options).handle({}, c.get('useCase'))))
        .post('/on', async c => toHttpResult(c, await new TurnGitOnHandler(options).handle(await jsonBody(c), c.get('useCase'))))
        .post('/reconcile', async c => toHttpResult(c, await new ReconcileHandler(options).handle({}, c.get('useCase'))))
        .delete('/', async c => toHttpResult(c, await new RemoveGitConfigHandler().handle({}, c.get('useCase'))));
}
