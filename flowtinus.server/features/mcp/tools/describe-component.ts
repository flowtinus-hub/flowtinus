import { z } from 'zod';
import { buildCatalog, END, START } from '@flowtinus/core';
import { defineTool, failed, ok } from './tool';

export const describeComponent = defineTool({
    name: 'describe_component',
    scope: 'catalog:read',
    description:
        "One component in full: its ports, settings (keys, kinds, defaults, options, when they apply) and a valid example config. Also 'start' and 'end'.",
    input: { type: z.string().describe("the component's type, from list_components (or 'start' / 'end')") },
    run: async ({ type }) => {
        const catalog = buildCatalog();
        if (type === START) {
            return ok({ type, ...catalog.start, outputs: [{ id: 'out-0' }] });
        }
        if (type === END) {
            return ok({ type, ...catalog.end, inputs: [{ id: 'in-0' }] });
        }
        const component = catalog.components.find(c => c.type === type);
        return component
            ? ok({ ...component, commonSettings: catalog.common.settings })
            : failed({ code: 'not-found', message: `No component of type "${type}" (list_components lists them).` });
    },
});
