import { Hono } from 'hono';
import { AddMemberHandler, ArchiveWorkspaceHandler, GetWorkspaceHandler, ListMembersHandler, RemoveMemberHandler, RestoreWorkspaceHandler, UpdateMemberHandler, UpdateWorkspaceHandler } from '#features/workspaces/workspaces-handlers';
import { toHttpResult } from '#shared/use-cases/to-http-result';
import type { AppEnv } from '../app-env';
import { bodyWith, jsonBody } from './request-input';

export function workspaceRoutes() {
    return new Hono<AppEnv>()
        .get('/', async c => toHttpResult(c, await new GetWorkspaceHandler().handle({}, c.get('useCase'))))
        .patch('/', async c => toHttpResult(c, await new UpdateWorkspaceHandler().handle(await jsonBody(c), c.get('useCase'))))
        .post('/archive', async c => toHttpResult(c, await new ArchiveWorkspaceHandler().handle({}, c.get('useCase'))))
        .post('/restore', async c => toHttpResult(c, await new RestoreWorkspaceHandler().handle({}, c.get('useCase'))))
        .get('/members', async c => toHttpResult(c, await new ListMembersHandler().handle({}, c.get('useCase'))))
        .post('/members', async c => toHttpResult(c, await new AddMemberHandler().handle(await jsonBody(c), c.get('useCase')), 201))
        .patch('/members/:userId', async c =>
            toHttpResult(c, await new UpdateMemberHandler().handle(await bodyWith(c, { userId: c.req.param('userId') }), c.get('useCase'))),
        )
        .delete('/members/:userId', async c =>
            toHttpResult(c, await new RemoveMemberHandler().handle({ userId: c.req.param('userId') }, c.get('useCase'))),
        );
}
