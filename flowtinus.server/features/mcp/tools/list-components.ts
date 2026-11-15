import { catalogComponents } from '@flowtinus/core';
import { defineTool, ok } from './tool';

export const listComponents = defineTool({
    name: 'list_components',
    scope: 'catalog:read',
    description:
        'Every component a flow can use: type, name, palette category, what it does, whether it writes outside the run. describe_component gives one in full.',
    input: {},
    run: async () =>
        ok({
            components: catalogComponents().map(c => ({
                type: c.type,
                label: c.label,
                category: c.category,
                description: c.description,
                sideEffects: c.sideEffects,
            })),
            alsoInEveryFlow: ['start', 'end'],
        }),
});
