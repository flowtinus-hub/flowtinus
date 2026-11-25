import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ArchiveFlowHandler } from '#features/flows/archive-flow/archive-flow-handler';
import { CloneFlowHandler } from '#features/flows/clone-flow/clone-flow-handler';
import { DiscardDraftHandler } from '#features/flows/discard-draft/discard-draft-handler';
import { GetDraftHandler } from '#features/flows/get-draft/get-draft-handler';
import { GetFlowHandler } from '#features/flows/get-flow/get-flow-handler';
import { MoveFlowHandler } from '#features/flows/move-flow/move-flow-handler';
import { RenameFlowHandler } from '#features/flows/rename-flow/rename-flow-handler';
import { DeleteFlowHandler } from '#features/flows/delete-flow/delete-flow-handler';
import { RestoreFlowHandler } from '#features/flows/restore-flow/restore-flow-handler';
import { SaveDraftHandler } from '#features/flows/save-draft/save-draft-handler';
import { GetPinsHandler, SetPinHandler, UnpinHandler } from '#features/pins/pin-handlers';
import { SetFlowWorkerTagHandler } from '#features/flows/set-flow-worker-tag/set-flow-worker-tag-handler';
import { DeployFlowHandler } from '#features/deployments/deploy-flow/deploy-flow-handler';
import { DeployVersionHandler } from '#features/deployments/deploy-version/deploy-version-handler';
import { EmergencyRollbackChecksHandler, EmergencyRollbackHandler, EndEmergencyRollbackHandler } from '#features/deployments/emergency-rollback/emergency-rollback-handlers';
import { GetDeploymentsHandler } from '#features/deployments/get-deployments/get-deployments-handler';
import { RestoreDraftHandler } from '#features/deployments/restore-draft/restore-draft-handler';
import { UndeployFlowHandler } from '#features/deployments/undeploy-flow/undeploy-flow-handler';
import { CancelRunHandler } from '#features/runs/cancel-run/cancel-run-handler';
import { GetRunHandler } from '#features/runs/get-run/get-run-handler';
import { LastRunHandler } from '#features/runs/last-run/last-run-handler';
import { ListRunsHandler, RunOverviewHandler, RunTreeHandler } from '#features/runs/list-runs/list-runs-handler';
import { DeleteScheduleHandler } from '#features/schedules/delete-schedule/delete-schedule-handler';
import { ListSchedulesHandler } from '#features/schedules/list-schedules/list-schedules-handler';
import { SaveScheduleHandler } from '#features/schedules/save-schedule/save-schedule-handler';
import { SwitchScheduleHandler } from '#features/schedules/switch-schedule/switch-schedule-handler';
import { OverrideScheduleHandler } from '#features/schedules/override-schedule/override-schedule-handler';
import { CreateWebhookHandler, DeleteWebhookHandler, ListWebhooksHandler, NewWebhookTokenHandler, SwitchWebhookHandler, UpdateWebhookHandler } from '#features/webhooks/manage-webhooks/manage-webhooks-handlers';
import { GetFlowTriggersHandler, RemoveFileTriggerHandler, SaveFileTriggerHandler } from '#features/flows/flow-triggers/flow-triggers-handlers';
import { RerunRunHandler } from '#features/runs/rerun-run/rerun-run-handler';
import { StartRunHandler } from '#features/runs/start-run/start-run-handler';
import type { RunProgress, RunRecord } from '@flowtinus/core';
import { workspaceRunEvents, runEvents, type RunEvent } from '#features/runs/run-events';
import { toHttpResult } from '#shared/use-cases/to-http-result';
import type { AppEnv } from '../app-env';
import { bodyWith, jsonBody } from './request-input';
import { memberWorkspaces, runContext } from '../middlewares/run-context';

export function flowsRoutes() {
    return new Hono<AppEnv>()
        .get('/:id', async c => {
            const result = await new GetFlowHandler().handle({ id: c.req.param('id') }, c.get('useCase'));
            return toHttpResult(c, result);
        })
        .patch('/:id', async c => {
            const result = await new RenameFlowHandler().handle(await bodyWith(c, { id: c.req.param('id') }), c.get('useCase'));
            return toHttpResult(c, result);
        })
        .put('/:id/worker-tag', async c => {
            const result = await new SetFlowWorkerTagHandler().handle(await bodyWith(c, { id: c.req.param('id') }), c.get('useCase'));
            return toHttpResult(c, result);
        })
        .post('/:id/move', async c => {
            const result = await new MoveFlowHandler().handle(await bodyWith(c, { id: c.req.param('id') }), c.get('useCase'));
            return toHttpResult(c, result);
        })
        .post('/:id/clone', async c => {
            const result = await new CloneFlowHandler().handle(await bodyWith(c, { id: c.req.param('id') }), c.get('useCase'));
            return toHttpResult(c, result, 201);
        })
        .post('/:id/archive', async c => {
            const result = await new ArchiveFlowHandler().handle({ id: c.req.param('id') }, c.get('useCase'));
            return toHttpResult(c, result);
        })
        .post('/:id/restore', async c => {
            const result = await new RestoreFlowHandler().handle({ id: c.req.param('id') }, c.get('useCase'));
            return toHttpResult(c, result);
        })
        .delete('/:id', async c => {
            const result = await new DeleteFlowHandler().handle({ id: c.req.param('id') }, c.get('useCase'));
            return toHttpResult(c, result);
        })
        .get('/:id/draft', async c => {
            const result = await new GetDraftHandler().handle({ id: c.req.param('id') }, c.get('useCase'));
            return toHttpResult(c, result);
        })
        .post('/:id/draft/discard', async c => {
            const result = await new DiscardDraftHandler().handle(
                (await bodyWith(c, { id: c.req.param('id') })) ?? { id: c.req.param('id') },
                c.get('useCase'),
            );
            return toHttpResult(c, result);
        })
        .get('/:id/pins', async c => toHttpResult(c, await new GetPinsHandler().handle({ id: c.req.param('id') }, c.get('useCase'))))
        .put('/:id/pins/:nodeId', async c =>
            toHttpResult(
                c,
                await new SetPinHandler().handle(
                    await bodyWith(c, { id: c.req.param('id'), nodeId: c.req.param('nodeId') }),
                    c.get('useCase'),
                ),
            ),
        )
        .delete('/:id/pins/:nodeId', async c =>
            toHttpResult(c, await new UnpinHandler().handle({ id: c.req.param('id'), nodeId: c.req.param('nodeId') }, c.get('useCase'))),
        )
        .get('/:id/last-run', async c => toHttpResult(c, await new LastRunHandler().handle({ id: c.req.param('id') }, c.get('useCase'))))
        .put('/:id/draft', async c => {
            const result = await new SaveDraftHandler().handle(await bodyWith(c, { id: c.req.param('id') }), c.get('useCase'));
            return toHttpResult(c, result);
        })
        .get('/:id/deployments', async c =>
            toHttpResult(c, await new GetDeploymentsHandler().handle({ id: c.req.param('id') }, c.get('useCase'))),
        )
        .post('/:id/deploy', async c =>
            toHttpResult(
                c,
                await new DeployFlowHandler().handle(
                    (await bodyWith(c, { id: c.req.param('id') })) ?? { id: c.req.param('id') },
                    c.get('useCase'),
                ),
            ),
        )
        .post('/:id/versions/:versionId/deploy', async c =>
            toHttpResult(
                c,
                await new DeployVersionHandler().handle({ id: c.req.param('id'), versionId: c.req.param('versionId') }, c.get('useCase')),
            ),
        )
        .get('/:id/versions/:versionId/emergency-rollback', async c =>
            toHttpResult(
                c,
                await new EmergencyRollbackChecksHandler().handle(
                    { id: c.req.param('id'), versionId: c.req.param('versionId') },
                    c.get('useCase'),
                ),
            ),
        )
        .post('/:id/versions/:versionId/emergency-rollback', async c =>
            toHttpResult(
                c,
                await new EmergencyRollbackHandler().handle(
                    { id: c.req.param('id'), versionId: c.req.param('versionId') },
                    c.get('useCase'),
                ),
            ),
        )
        .delete('/:id/emergency-rollback', async c =>
            toHttpResult(c, await new EndEmergencyRollbackHandler().handle({ id: c.req.param('id') }, c.get('useCase'))),
        )
        .post('/:id/undeploy', async c =>
            toHttpResult(c, await new UndeployFlowHandler().handle({ id: c.req.param('id') }, c.get('useCase'))),
        )
        .post('/:id/versions/:versionId/restore-draft', async c =>
            toHttpResult(
                c,
                await new RestoreDraftHandler().handle({ id: c.req.param('id'), versionId: c.req.param('versionId') }, c.get('useCase')),
            ),
        )
        .get('/:id/schedules', async c =>
            toHttpResult(c, await new ListSchedulesHandler().handle({ id: c.req.param('id') }, c.get('useCase'))),
        )
        .post('/:id/schedules', async c =>
            toHttpResult(
                c,
                await new SaveScheduleHandler('create').handle({ flowId: c.req.param('id'), fields: await jsonBody(c) }, c.get('useCase')),
                201,
            ),
        )
        .get('/:id/triggers', async c =>
            toHttpResult(c, await new GetFlowTriggersHandler().handle({ id: c.req.param('id') }, c.get('useCase'))),
        )
        .post('/:id/triggers/schedules', async c =>
            toHttpResult(
                c,
                await new SaveFileTriggerHandler('schedule').handle({ id: c.req.param('id'), fields: await jsonBody(c) }, c.get('useCase')),
                201,
            ),
        )
        .put('/:id/triggers/schedules/:scheduleId', async c =>
            toHttpResult(
                c,
                await new SaveFileTriggerHandler('schedule').handle(
                    { id: c.req.param('id'), triggerId: c.req.param('scheduleId'), fields: await jsonBody(c) },
                    c.get('useCase'),
                ),
            ),
        )
        .delete('/:id/triggers/schedules/:scheduleId', async c =>
            toHttpResult(
                c,
                await new RemoveFileTriggerHandler('schedule').handle(
                    { id: c.req.param('id'), triggerId: c.req.param('scheduleId') },
                    c.get('useCase'),
                ),
            ),
        )
        .post('/:id/triggers/webhooks', async c =>
            toHttpResult(
                c,
                await new SaveFileTriggerHandler('webhook').handle({ id: c.req.param('id'), fields: await jsonBody(c) }, c.get('useCase')),
                201,
            ),
        )
        .put('/:id/triggers/webhooks/:webhookId', async c =>
            toHttpResult(
                c,
                await new SaveFileTriggerHandler('webhook').handle(
                    { id: c.req.param('id'), triggerId: c.req.param('webhookId'), fields: await jsonBody(c) },
                    c.get('useCase'),
                ),
            ),
        )
        .delete('/:id/triggers/webhooks/:webhookId', async c =>
            toHttpResult(
                c,
                await new RemoveFileTriggerHandler('webhook').handle(
                    { id: c.req.param('id'), triggerId: c.req.param('webhookId') },
                    c.get('useCase'),
                ),
            ),
        )
        .get('/:id/webhooks', async c =>
            toHttpResult(c, await new ListWebhooksHandler().handle({ id: c.req.param('id') }, c.get('useCase'))),
        )
        .post('/:id/webhooks', async c =>
            toHttpResult(
                c,
                await new CreateWebhookHandler().handle({ flowId: c.req.param('id'), fields: await jsonBody(c) }, c.get('useCase')),
                201,
            ),
        )
        .post('/:id/runs', async c => {
            const result = await new StartRunHandler().handle(await bodyWith(c, { id: c.req.param('id') }), c.get('useCase'));
            return toHttpResult(c, result, 202);
        });
}

/** the Runs page's stream says it is alive this often (Bun closes a connection quiet for longer than its idle timeout) */
export const SSE_PING_MS = 5_000;

export function runsRoutes() {
    return (
        new Hono<AppEnv>()
            .get('/', memberWorkspaces(), async c => toHttpResult(c, await new ListRunsHandler().handle(c.req.query(), c.get('useCase'))))
            .get('/overview', memberWorkspaces(), async c =>
                toHttpResult(c, await new RunOverviewHandler().handle(c.req.query(), c.get('useCase'))),
            )
            // the runs of the user's workspaces that change (SSE): "change" {id, rootId, status} when one is queued, taken by a worker or
            // ends (never its progress); "ping" every few seconds, well within the server's idle timeout (server.ts) and a
            // proxy's: a quiet stream would be closed, and the editor takes a stream silent for long as dead
            .get('/events', memberWorkspaces(), c => {
                const { workspaceIds = [] } = c.get('useCase');
                return streamSSE(c, async stream => {
                    let writing = Promise.resolve();
                    const stops = workspaceIds.map(workspaceId =>
                        workspaceRunEvents.subscribe(workspaceId, change => {
                            writing = writing.then(() => stream.writeSSE({ event: 'change', data: JSON.stringify(change) }));
                        }),
                    );
                    const stop = () => stops.forEach(s => s());
                    let open = true;
                    stream.onAbort(() => {
                        open = false;
                        stop();
                    });
                    await stream.writeSSE({ event: 'ready', data: '{}' });
                    while (open) {
                        await stream.sleep(SSE_PING_MS);
                        if (open) {
                            writing = writing.then(() => stream.writeSSE({ event: 'ping', data: '{}' }));
                        }
                    }
                });
            })
            .use('/:id/*', runContext())
            .use('/:id', runContext())
            .get('/:id/tree', async c => toHttpResult(c, await new RunTreeHandler().handle({ id: c.req.param('id') }, c.get('useCase'))))
            .get('/:id', async c => {
                const result = await new GetRunHandler().handle({ id: c.req.param('id') }, c.get('useCase'));
                return toHttpResult(c, result);
            })
            .post('/:id/rerun', async c =>
                toHttpResult(c, await new RerunRunHandler().handle({ id: c.req.param('id') }, c.get('useCase')), 202),
            )
            .post('/:id/cancel', async c => {
                const result = await new CancelRunHandler().handle({ id: c.req.param('id') }, c.get('useCase'));
                return toHttpResult(c, result);
            })
            .get('/:id/events', async c => {
                const result = await new GetRunHandler().handle({ id: c.req.param('id') }, c.get('useCase'));
                if (!result.ok) {
                    return toHttpResult(c, result);
                }

                const run = result.value;
                return streamSSE(c, async stream => {
                    const send = async (event: RunEvent) => {
                        if (event.type === 'done' && event.usage) {
                            await stream.writeSSE({ event: 'usage', data: JSON.stringify(event.usage) });
                        }

                        await stream.writeSSE({
                            event: event.type,
                            data: JSON.stringify(event.type === 'progress' ? event.progress : event.record),
                        });
                    };
                    if (run.status !== 'running' && run.status !== 'queued') {
                        await send({ type: 'done', record: run.record as RunRecord, usage: run.usage });
                        return;
                    }

                    let resolveDone: () => void = () => {};
                    const done = new Promise<void>(resolve => (resolveDone = resolve));
                    let writing = Promise.resolve();
                    const stop = runEvents.subscribe(run.id, event => {
                        writing = writing.then(() => send(event));
                        if (event.type === 'done') {
                            void writing.finally(resolveDone);
                        }
                    });
                    stream.onAbort(() => {
                        stop();
                        resolveDone();
                    });
                    // it may have ended between the read above and the subscription: then its record now
                    const again = await new GetRunHandler().handle({ id: run.id }, c.get('useCase'));
                    if (again.ok && again.value.status !== 'running' && again.value.status !== 'queued') {
                        stop();
                        await send({ type: 'done', record: again.value.record as RunRecord, usage: again.value.usage });
                        return;
                    }

                    if (again.ok && again.value.status === 'running' && again.value.record) {
                        writing = writing.then(() => send({ type: 'progress', progress: again.value.record as RunProgress }));
                    }

                    await done;
                    stop();
                });
            })
    );
}

export function schedulesRoutes() {
    return new Hono<AppEnv>()
        .put('/:id', async c =>
            toHttpResult(
                c,
                await new SaveScheduleHandler('update').handle({ id: c.req.param('id'), fields: await jsonBody(c) }, c.get('useCase')),
            ),
        )
        .put('/:id/enabled', async c =>
            toHttpResult(c, await new SwitchScheduleHandler().handle(await bodyWith(c, { id: c.req.param('id') }), c.get('useCase'))),
        )
        .put('/:id/overrides', async c =>
            toHttpResult(c, await new OverrideScheduleHandler().handle(await bodyWith(c, { id: c.req.param('id') }), c.get('useCase'))),
        )
        .delete('/:id', async c => toHttpResult(c, await new DeleteScheduleHandler().handle({ id: c.req.param('id') }, c.get('useCase'))));
}

export function webhooksRoutes() {
    return new Hono<AppEnv>()
        .put('/:id', async c =>
            toHttpResult(
                c,
                await new UpdateWebhookHandler().handle({ id: c.req.param('id'), fields: await jsonBody(c) }, c.get('useCase')),
            ),
        )
        .put('/:id/enabled', async c =>
            toHttpResult(c, await new SwitchWebhookHandler().handle(await bodyWith(c, { id: c.req.param('id') }), c.get('useCase'))),
        )
        .post('/:id/token', async c =>
            toHttpResult(c, await new NewWebhookTokenHandler().handle({ id: c.req.param('id') }, c.get('useCase'))),
        )
        .delete('/:id', async c => toHttpResult(c, await new DeleteWebhookHandler().handle({ id: c.req.param('id') }, c.get('useCase'))));
}
