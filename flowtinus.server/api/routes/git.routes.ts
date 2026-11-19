import { Hono } from 'hono';
import type { GitOptions } from '#features/git/git-config';
import { CreateTopologyHandler, GetGitConfigHandler, GetTopologyHandler, GetTurnOnPlanHandler, GetGitStatusHandler, ReconcileHandler, RemoveGitConfigHandler, RenewHookTokenHandler, SaveGitConfigHandler, TestGitAccessHandler, TurnGitOnHandler } from '#features/git/git-handlers';
import { GetCurrentBranchHandler, SetCurrentBranchHandler } from '#features/git/current-branch';
import { ListBranchesHandler } from '#features/git/branches';
import { CommitChangesHandler, DiscardChangesHandler, GetChangesHandler } from '#features/git/working-copy-handlers';
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
        .get('/status', async c => toHttpResult(c, await new GetGitStatusHandler().handle({}, c.get('useCase'))))
        .get('/branches', async c => toHttpResult(c, await new ListBranchesHandler(options).handle({}, c.get('useCase'))))
        .get('/current-branch', async c => toHttpResult(c, await new GetCurrentBranchHandler().handle({}, c.get('useCase'))))
        .put('/current-branch', async c => toHttpResult(c, await new SetCurrentBranchHandler().handle(await jsonBody(c), c.get('useCase'))))
        .post('/hook-token', async c => toHttpResult(c, await new RenewHookTokenHandler().handle({}, c.get('useCase'))))
        .get('/changes', async c => toHttpResult(c, await new GetChangesHandler().handle({}, c.get('useCase'))))
        .post('/commit', async c => toHttpResult(c, await new CommitChangesHandler().handle(await jsonBody(c), c.get('useCase'))))
        .post('/discard', async c => toHttpResult(c, await new DiscardChangesHandler().handle(await jsonBody(c), c.get('useCase'))))
        .post('/reconcile', async c => toHttpResult(c, await new ReconcileHandler(options).handle({}, c.get('useCase'))))
        .delete('/', async c => toHttpResult(c, await new RemoveGitConfigHandler().handle({}, c.get('useCase'))));
}
