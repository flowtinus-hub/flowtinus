import { buildCatalog } from '@flowtinus/core';
import { defineTool, ok } from './tool';

export const getFlowFormat = defineTool({
    name: 'get_flow_format',
    scope: 'catalog:read',
    description:
        'The flow file (YAML) an agent writes: its shape, port names, connections, expressions, the rules validate_flow checks, patterns for common needs (a step once after everything: a barrier; an incremental load with a checkpoint; a lock) and a full annotated example. Read it before writing a flow.',
    input: {},
    run: async () => {
        const { flowFile, expressions, rules, patterns, common } = buildCatalog();
        return ok({ ...flowFile, expressions, rules, patterns, onError: common });
    },
});
