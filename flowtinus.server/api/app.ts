import { Hono } from 'hono';
import type { Keyring } from '#shared/crypto/keyring';
import type { Database } from '#shared/database/database';
import type { Logger } from '#shared/logging/logger';
import type { AppEnv } from './app-env';
import { accessLog } from './middlewares/access-log';
import { requestContext } from './middlewares/request-context';
import { flowsRoutes, runsRoutes, schedulesRoutes, webhooksRoutes } from './routes/flows.routes';
import { callWebhook } from '#features/webhooks/call-webhook';
import { foldersRoutes } from './routes/folders.routes';
import { projectResourcesRoutes } from './routes/project-resources.routes';
import { projectsRoutes } from './routes/projects.routes';
import { ListSupervisorsHandler } from '#features/supervisors/list-supervisors/list-supervisors-handler';
import { toHttpResult } from '#shared/use-cases/to-http-result';
import { streamSSE } from 'hono/streaming';
import { mcpRoute, type McpRouteOptions } from './routes/mcp.routes';
import { workspaceContext } from './middlewares/workspace-context';
import { workspaceRoutes } from './routes/workspaces.routes';
import { tokensRoutes } from './routes/tokens.routes';
import { gitRoutes } from './routes/git.routes';
import { gitOptions, type GitOptions } from '#features/git/git-config';
import { jsonBody } from './routes/request-input';
import { CreateWorkspaceHandler, GetMeHandler, ListWorkspacesHandler } from '#features/workspaces/workspaces-handlers';

export const WORKERS_CHECK_MS = 2000;

export type AppOptions = McpRouteOptions & { git?: Partial<GitOptions> };

export function createApp(db: Database, environment: string, keyring?: Keyring, logger?: Logger, options: AppOptions = {}) {
    const { git, ...mcp } = options;
    const app = new Hono<AppEnv>();
    if (logger) {
        app.use('*', accessLog(logger));
    }

    app.get('/health', c => c.json({ ok: true, environment }));

    // a webhook's address, called by other systems: outside the editor's api (no user), its token says who may call
    app.all('/wh/:id', async c => {
        const answer = await callWebhook(db, {
            id: c.req.param('id'),
            method: c.req.method,
            authorization: c.req.header('authorization'),
            query: c.req.query(),
            body: c.req.method === 'POST' ? await c.req.text() : undefined,
        });
        return c.json(answer.body, answer.status as 200);
    });

    // the MCP (Streamable HTTP, stateless) for agents: outside the editor's api too, a personal access token says who calls
    app.all('/mcp', ...mcpRoute(db, keyring, mcp));

    app.use('*', requestContext(db, keyring));
    app.get('/me', async c => toHttpResult(c, await new GetMeHandler().handle({}, c.get('useCase'))));
    app.get('/workspaces', async c => toHttpResult(c, await new ListWorkspacesHandler().handle(c.req.query(), c.get('useCase'))));
    app.post('/workspaces', async c =>
        toHttpResult(c, await new CreateWorkspaceHandler().handle(await jsonBody(c), c.get('useCase')), 201),
    );
    app.route('/runs', runsRoutes());
    app.route('/tokens', tokensRoutes());
    app.get('/workers', async c => toHttpResult(c, await new ListSupervisorsHandler(environment).handle({}, c.get('useCase'))));
    // the same, live (SSE): "workers" with all of it when it opens and whenever it changes (looked at every WORKERS_CHECK_MS;
    // the supervisors' heartbeats change it every few seconds, so it also says the stream is alive)
    app.get('/workers/events', c =>
        streamSSE(c, async stream => {
            let open = true;
            stream.onAbort(() => {
                open = false;
            });
            let last = '';
            while (open) {
                const result = await new ListSupervisorsHandler(environment).handle({}, c.get('useCase'));
                const data = result.ok ? JSON.stringify(result.value) : '';
                if (open && data && data !== last) {
                    last = data;
                    await stream.writeSSE({ event: 'workers', data });
                } else if (open) {
                    await stream.writeSSE({ event: 'ping', data: '{}' });
                }

                await stream.sleep(WORKERS_CHECK_MS);
            }
        }),
    );
    const workspace = new Hono<AppEnv>();
    workspace.use('*', workspaceContext());
    workspace.route('/', workspaceRoutes());
    workspace.route('/projects', projectsRoutes());
    workspace.route('/folders', foldersRoutes());
    workspace.route('/flows', flowsRoutes());
    workspace.route('/schedules', schedulesRoutes());
    workspace.route('/webhooks', webhooksRoutes());
    workspace.route('/', projectResourcesRoutes());
    workspace.route('/git', gitRoutes(gitOptions(environment, git)));
    app.route('/w/:workspace', workspace);

    app.onError((error, c) => {
        if (logger) {
            logger.error(`Unexpected error on ${c.req.method} ${c.req.path}`, { method: c.req.method, path: c.req.path, error });
        } else {
            console.error(error);
        }

        return c.json({ error: { code: 'internal', message: 'Unexpected error.' } }, 500);
    });

    return app;
}
