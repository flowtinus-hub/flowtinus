import { Hono } from 'hono';
import type { GitOptions } from '#features/git/git-config';
import { CreateTopologyHandler, GetGitConfigHandler, GetTopologyHandler, GetTurnOnPlanHandler, GetGitStatusHandler, ReconcileHandler, RemoveGitConfigHandler, RenewHookTokenHandler, SaveGitConfigHandler, TestGitAccessHandler, TurnGitOnHandler } from '#features/git/git-handlers';
import { GetCurrentBranchHandler, SetCurrentBranchHandler } from '#features/git/current-branch';
import { ListBranchesHandler } from '#features/git/branches';
import { OpenPullRequestHandler } from '#features/git/pull-request';
import { CreateHotfixHandler } from '#features/git/hotfix';
import { GetFileDiffHandler } from '#features/git/file-diff';
import { GetEnvironmentsHandler } from '#features/git/environments';
import { GetCommitGraphHandler, GetPreflightHandler, GetRepairPreflightHandler, OpenPromotionHandler, OpenRepairHandler } from '#features/git/promotions';
import { GetBackportPreflightHandler, OpenBackportHandler } from '#features/git/backports';
import { ListArrivedDisabledHandler } from '#features/git/arrived-disabled';
import { DeleteArchivedConnectionHandler, ListArchivedConnectionsHandler } from '#features/git/archived-connections';
import { CommitChangesHandler, CreateBranchHandler, DiscardChangesHandler, GetChangesHandler, GetConflictHandler, GetUpdateHandler, ResolveConflictHandler, UpdateBranchHandler } from '#features/git/working-copy-handlers';
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
        .get('/environments', async c => toHttpResult(c, await new GetEnvironmentsHandler(options).handle({}, c.get('useCase'))))
        .get('/archived-connections', async c => toHttpResult(c, await new ListArchivedConnectionsHandler().handle({}, c.get('useCase'))))
        .delete('/archived-connections/:id', async c =>
            toHttpResult(c, await new DeleteArchivedConnectionHandler().handle({ id: c.req.param('id') }, c.get('useCase'))),
        )
        .get('/promotions/graph', async c =>
            toHttpResult(c, await new GetCommitGraphHandler(options).handle(c.req.query(), c.get('useCase'))),
        )
        .get('/promotions/preflight', async c =>
            toHttpResult(c, await new GetPreflightHandler(options).handle(c.req.query(), c.get('useCase'))),
        )
        .post('/promotions', async c =>
            toHttpResult(c, await new OpenPromotionHandler(options).handle(await jsonBody(c), c.get('useCase'))),
        )
        .post('/promotions/:id/repair', async c =>
            toHttpResult(c, await new OpenRepairHandler(options).handle({ id: c.req.param('id') }, c.get('useCase'))),
        )
        .get('/repairs/preflight', async c =>
            toHttpResult(c, await new GetRepairPreflightHandler().handle(c.req.query(), c.get('useCase'))),
        )
        .get('/backports/preflight', async c =>
            toHttpResult(c, await new GetBackportPreflightHandler(options).handle(c.req.query(), c.get('useCase'))),
        )
        .post('/backports', async c => toHttpResult(c, await new OpenBackportHandler(options).handle(await jsonBody(c), c.get('useCase'))))
        .get('/arrived-disabled', async c => toHttpResult(c, await new ListArrivedDisabledHandler().handle({}, c.get('useCase'))))
        .get('/branches', async c => toHttpResult(c, await new ListBranchesHandler(options).handle({}, c.get('useCase'))))
        .post('/branches', async c => toHttpResult(c, await new CreateBranchHandler().handle(await jsonBody(c), c.get('useCase')), 201))
        .post('/hotfix', async c => toHttpResult(c, await new CreateHotfixHandler().handle(await jsonBody(c), c.get('useCase')), 201))
        .get('/current-branch', async c => toHttpResult(c, await new GetCurrentBranchHandler().handle({}, c.get('useCase'))))
        .put('/current-branch', async c => toHttpResult(c, await new SetCurrentBranchHandler().handle(await jsonBody(c), c.get('useCase'))))
        .post('/hook-token', async c => toHttpResult(c, await new RenewHookTokenHandler().handle({}, c.get('useCase'))))
        .get('/changes', async c => toHttpResult(c, await new GetChangesHandler().handle({}, c.get('useCase'))))
        .get('/diff', async c => toHttpResult(c, await new GetFileDiffHandler().handle({ path: c.req.query('path') }, c.get('useCase'))))
        .post('/commit', async c => toHttpResult(c, await new CommitChangesHandler().handle(await jsonBody(c), c.get('useCase'))))
        .post('/discard', async c => toHttpResult(c, await new DiscardChangesHandler().handle(await jsonBody(c), c.get('useCase'))))
        .get('/update', async c => toHttpResult(c, await new GetUpdateHandler().handle({}, c.get('useCase'))))
        .post('/update', async c => toHttpResult(c, await new UpdateBranchHandler().handle({}, c.get('useCase'))))
        .get('/conflict', async c =>
            toHttpResult(c, await new GetConflictHandler().handle({ path: c.req.query('path') }, c.get('useCase'))),
        )
        .post('/conflict', async c => toHttpResult(c, await new ResolveConflictHandler().handle(await jsonBody(c), c.get('useCase'))))
        .post('/pull-request', async c => toHttpResult(c, await new OpenPullRequestHandler().handle(await jsonBody(c), c.get('useCase'))))
        .post('/reconcile', async c => toHttpResult(c, await new ReconcileHandler(options).handle({}, c.get('useCase'))))
        .delete('/', async c => toHttpResult(c, await new RemoveGitConfigHandler().handle({}, c.get('useCase'))));
}
