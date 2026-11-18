import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMiddleware } from 'hono/factory';
import type { Keyring } from '#shared/crypto/keyring';
import type { Database } from '#shared/database/database';
import type { GitOptions } from '#features/git/git-config';
import { createMcpServer, type McpOptions } from '#features/mcp/mcp-server';
import type { AppEnv } from '../app-env';
import { bearerAuth } from '../middlewares/bearer-auth';

export type McpRouteOptions = Pick<McpOptions, 'editorUrl' | 'pollMs' | 'maxWaitS'>;

/**
 * /mcp: the MCP over Streamable HTTP, stateless (no session: one server per request, its context from the request's
 * personal access token). Answers JSON (no SSE stream): every tool answers once. GET (a server stream) is 405.
 */
export function mcpRoute(db: Database, keyring: Keyring | undefined, options: McpRouteOptions, git?: GitOptions) {
    return [
        bearerAuth(db, keyring, git),
        createMiddleware<AppEnv>(async c => {
            const server = createMcpServer({
                ...options,
                ctx: c.get('useCase'),
                scopes: c.get('scopes') ?? [],
                runScope: c.get('runScope') ?? null,
            });
            const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
            await server.connect(transport);
            try {
                return await transport.handleRequest(c.req.raw);
            } finally {
                void server.close();
            }
        }),
    ] as const;
}
