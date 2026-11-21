import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireScope } from '#features/api-tokens/api-tokens';
import type { UseCaseError } from '#shared/use-cases/use-case-result';
import { buildFlowPrompt, debugRunPrompt, SERVER_INSTRUCTIONS } from './prompts';
import { registerResources } from './resources';
import { MCP_TOOLS } from './tools';
import { failed, toolContext, type McpOptions } from './tools/tool';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import { workspaceOfCall } from './workspace-of-call';
import { mcpCannotEdit } from '#features/git/current-branch';

export { MAX_YAML_BYTES, type McpOptions } from './tools/tool';
export { DEFAULT_TEST_RUN_WAIT_S, MAX_TEST_RUN_WAIT_S } from './tools/test-run';

/*
 * The MCP server of one request (stateless, /mcp): the tools (one per file in tools/), resources and prompts an agent
 * uses to read, write, validate and test flows the way the editor does. Every tool goes through the same use case
 * handlers as the editor's api (never SQL of its own, except the checks of project-checks.ts and the resource lists),
 * as the token's user in the workspace the call names (or the one of the flow, project or run it names: workspace-of-call.ts),
 * and checks the token's scope first. No deploy, promotion, secret value or connection field ever
 * goes through here.
 */

export function createMcpServer(options: McpOptions): McpServer {
    const server = new McpServer({ name: 'flowtinus', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
    const base = toolContext(options);
    const scoped = async (args: Record<string, unknown>) => {
        const found = await workspaceOfCall(options.ctx, args);
        if (!found.ok) {
            return found;
        }
        return { ok: true as const, value: found.value ? toolContext({ ...options, ctx: found.value.ctx }, found.value.handle) : base };
    };

    for (const tool of MCP_TOOLS) {
        server.registerTool(
            tool.name,
            { description: tool.description, inputSchema: tool.input, annotations: tool.annotations ?? { readOnlyHint: true } },
            (async (args: never) => {
                const missing = requireScope(options.scopes, tool.scope);
                if (missing && !missing.ok) {
                    return failed(missing.error);
                }
                try {
                    const t = await scoped(args as Record<string, unknown>);
                    if (!t.ok) {
                        return failed(t.error);
                    }
                    const { ctx } = t.value;
                    const refused = tool.editsBranch && ctx.workspaceId ? await mcpCannotEdit(ctx.db, ctx.workspaceId, ctx.userId) : null;
                    if (refused) {
                        return failed({ code: 'conflict', message: refused });
                    }
                    return await tool.run(args, t.value);
                } catch (error) {
                    if (error instanceof UseCaseFailure) {
                        return failed(error.error);
                    }
                    console.error(`MCP tool ${tool.name} failed`, error);
                    return failed({ code: 'internal' as UseCaseError['code'], message: 'Unexpected error.' });
                }
            }) as never,
        );
    }

    registerResources(server, base, options.scopes, scoped);

    server.registerPrompt(
        'build-flow',
        {
            description: 'Build one or more flows from a description of a process: catalog, project, flows, validate, save, test run, fix.',
            argsSchema: {
                description: z.string().describe('what the flows must do (or where the documentation of the process is)'),
                projectId: z.string().optional().describe('the project, when known (or an editor link)'),
            },
        },
        ({ description, projectId }) => ({
            messages: [{ role: 'user', content: { type: 'text', text: buildFlowPrompt(description, projectId) } }],
        }),
    );
    server.registerPrompt(
        'debug-run',
        {
            description: 'Find out why a run failed and fix its flow.',
            argsSchema: { run: z.string().describe('the run id, or an editor link to the run or the flow') },
        },
        ({ run }) => ({ messages: [{ role: 'user', content: { type: 'text', text: debugRunPrompt(run) } }] }),
    );

    return server;
}
