import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildCatalog, catalogComponents, flowToYaml } from '@flowtinus/core';
import { requireScope, type ApiScope } from '#features/api-tokens/api-tokens';
import type { ToolContext } from './tools/tool';
import type { UseCaseError } from '#shared/use-cases/use-case-result';

type Contents = { contents: { uri: string; mimeType: string; text: string }[] };

const json = (uri: URL, value: unknown): Contents => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value) }],
});

export function registerResources(
    server: McpServer,
    _base: ToolContext,
    scopes: readonly ApiScope[],
    scoped: (args: Record<string, unknown>) => Promise<{ ok: true; value: ToolContext } | { ok: false; error: UseCaseError }>,
) {
    const guarded = (scope: ApiScope, uri: URL, read: () => Promise<Contents>) => {
        const missing = requireScope(scopes, scope);
        return missing && !missing.ok ? Promise.resolve(json(uri, { error: missing.error })) : read();
    };

    server.registerResource(
        'catalog',
        'flowtinus://catalog',
        { description: 'Every component, the connection types, the flow file format and its rules (JSON).', mimeType: 'application/json' },
        async uri => guarded('catalog:read', uri, async () => json(uri, buildCatalog())),
    );
    server.registerResource(
        'component',
        new ResourceTemplate('flowtinus://components/{type}', {
            list: async () => ({
                resources: catalogComponents().map(c => ({
                    uri: `flowtinus://components/${c.type}`,
                    name: c.label,
                    description: c.description,
                    mimeType: 'application/json',
                })),
            }),
        }),
        { description: 'One component: ports, settings and an example config (JSON).', mimeType: 'application/json' },
        async (uri, { type }) =>
            guarded('catalog:read', uri, async () =>
                json(
                    uri,
                    catalogComponents().find(c => c.type === type) ?? {
                        error: { code: 'not-found', message: `No component of type "${type}".` },
                    },
                ),
            ),
    );
    server.registerResource(
        'connection-types',
        'flowtinus://connections',
        { description: 'The connection profile types and their fields (JSON).', mimeType: 'application/json' },
        async uri => guarded('catalog:read', uri, async () => json(uri, buildCatalog().connectionTypes)),
    );
    server.registerResource(
        'flow-format',
        'flowtinus://docs/flow-format',
        {
            description: 'The flow file format, expressions, rules, patterns for common needs and a full example (JSON).',
            mimeType: 'application/json',
        },
        async uri =>
            guarded('catalog:read', uri, async () => {
                const { flowFile, expressions, rules, patterns, start, end, common } = buildCatalog();
                return json(uri, { ...flowFile, start, end, onError: common, expressions, rules, patterns });
            }),
    );
    server.registerResource(
        'flow-draft',
        new ResourceTemplate('flowtinus://flows/{flowId}', { list: undefined }),
        { description: "A flow's draft as a flow file (YAML), pinned outputs left out.", mimeType: 'text/yaml' },
        async (uri, { flowId }) =>
            guarded('flows:read', uri, async () => {
                const call = await scoped({ flowId: String(flowId) });
                if (!call.ok) {
                    return json(uri, { error: call.error });
                }
                const found = await call.value.flowAndDraft(String(flowId));
                if (!found.ok) {
                    return json(uri, { error: found.error });
                }
                const { draft } = found.value;
                const yaml = flowToYaml({ ...draft.flow, nodes: draft.flow.nodes.map(({ pinned: _pinned, ...n }) => n) });
                return { contents: [{ uri: uri.href, mimeType: 'text/yaml', text: `# revision: ${draft.revision}\n${yaml}` }] };
            }),
    );
}
