import { expect, test } from 'bun:test';
import { flowWithScriptsMoved, movedScriptImports, type FlowFile } from '../../src/index';

const P = '@w/acme/sales/scripts/';

test('moving a script or a folder moves the imports of it, and only those', () => {
    const code = `import { round } from '@w/acme/sales/scripts/lib/prices';
import * as all from "@w/acme/sales/scripts/lib/tax/rates";
const later = await import('@w/acme/sales/scripts/lib/prices');
import { x } from '@w/acme/sales/scripts/library';
import { y } from './lib/prices';`;
    expect(movedScriptImports(code, P + 'lib', P + 'shared')).toBe(`import { round } from '@w/acme/sales/scripts/shared/prices';
import * as all from "@w/acme/sales/scripts/shared/tax/rates";
const later = await import('@w/acme/sales/scripts/shared/prices');
import { x } from '@w/acme/sales/scripts/library';
import { y } from './lib/prices';`);
    expect(movedScriptImports(code, P + 'lib/prices', P + 'lib/cost')).toContain(`from '@w/acme/sales/scripts/lib/cost';`);
    expect(movedScriptImports(code, P + 'nothing', P + 'else')).toBe(code);
});

test("a flow's TypeScript imports, Script Invoker functions and script types follow a moved script", () => {
    const flow: FlowFile = {
        version: 1,
        name: 'Orders',
        nodes: [
            {
                id: 'start',
                type: 'start',
                position: { x: 0, y: 0 },
                config: { acceptsInput: true, inputType: '@w/acme/sales/scripts/lib/types#Order' },
            },
            {
                id: 'ts',
                type: 'typescript',
                position: { x: 0, y: 0 },
                config: { code: "import { a } from '@w/acme/sales/scripts/lib/prices';" },
            },
            { id: 'call', type: 'script', position: { x: 0, y: 0 }, config: { function: '@w/acme/sales/scripts/lib/prices#round' } },
            { id: 'end', type: 'end', position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [],
    };
    const moved = flowWithScriptsMoved(flow, P + 'lib', P + 'shared')!;
    expect(moved.nodes.map(n => n.config)).toEqual([
        { acceptsInput: true, inputType: '@w/acme/sales/scripts/shared/types#Order' },
        { code: "import { a } from '@w/acme/sales/scripts/shared/prices';" },
        { function: '@w/acme/sales/scripts/shared/prices#round' },
        {},
    ]);
    expect(moved.nodes[3]).toBe(flow.nodes[3]!);
    expect(flowWithScriptsMoved(flow, P + 'other', P + 'place')).toBeUndefined();
});
