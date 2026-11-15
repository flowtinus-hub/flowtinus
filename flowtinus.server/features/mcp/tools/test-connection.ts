import { TestConnectionHandler } from '#features/connections/test-connection/test-connection-handler';
import { defineTool, failed, id, ok } from './tool';

export const testConnection = defineTool({
    name: 'test_connection',
    scope: 'resources:read',
    description:
        "Tests a connection profile of the workspace as the editor's Test connection does: connects, reads the server's version and closes (nothing is written). Answers ok with the message, the time and, for a database, the server it reached (engine and version: e.g. a \"Redshift\" connection may answer as PostgreSQL 18.0), with a warning when the engine is not the type's; or ok false and why it failed (secret values hidden). The server found is kept with the connection: list_connections shows it.",
    input: { connectionId: id('the connection profile, from list_connections') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async ({ connectionId }, t) => {
        const tested = await new TestConnectionHandler().handle({ id: connectionId }, t.ctx);
        if (tested.ok) {
            return ok({ ok: true, ...tested.value });
        }
        // a refusal of the server (not found, no role) is the tool's error; a connection that failed is the answer
        return tested.error.code === 'unavailable' || tested.error.code === 'validation'
            ? ok({ ok: false, error: tested.error.message })
            : failed(tested.error);
    },
});
