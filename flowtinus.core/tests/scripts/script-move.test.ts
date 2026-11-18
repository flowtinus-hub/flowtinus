import { expect, test } from 'bun:test';
import { flowWithScriptsMoved, movedScriptImports, type FlowFile } from '../../src/index';

test('moving a script or a folder moves the imports of it, and only those', () => {
    const code = `import { round } from '@myproject/scripts/lib/prices';
import * as all from "@myproject/scripts/lib/tax/rates";
const later = await import('@myproject/scripts/lib/prices');
import { x } from '@myproject/scripts/library';
import { y } from './lib/prices';`;
    expect(movedScriptImports(code, 'lib', 'shared')).toBe(`import { round } from '@myproject/scripts/shared/prices';
import * as all from "@myproject/scripts/shared/tax/rates";
const later = await import('@myproject/scripts/shared/prices');
import { x } from '@myproject/scripts/library';
import { y } from './lib/prices';`);
    expect(movedScriptImports(code, 'lib/prices', 'lib/cost')).toContain(`from '@myproject/scripts/lib/cost';`);
    expect(movedScriptImports(code, 'nothing', 'else')).toBe(code);
});

test("a flow's TypeScript imports, Script Invoker functions and script types follow a moved script", () => {
    const flow: FlowFile = {
        version: 1,
        name: 'Orders',
        nodes: [
            { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: { acceptsInput: true, inputType: 'lib/types#Order' } },
            {
                id: 'ts',
                type: 'typescript',
                position: { x: 0, y: 0 },
                config: { code: "import { a } from '@myproject/scripts/lib/prices';" },
            },
            { id: 'call', type: 'script', position: { x: 0, y: 0 }, config: { function: 'lib/prices#round' } },
            { id: 'end', type: 'end', position: { x: 0, y: 0 }, config: {} },
        ],
        edges: [],
    };
    const moved = flowWithScriptsMoved(flow, 'lib', 'shared')!;
    expect(moved.nodes.map(n => n.config)).toEqual([
        { acceptsInput: true, inputType: 'shared/types#Order' },
        { code: "import { a } from '@myproject/scripts/shared/prices';" },
        { function: 'shared/prices#round' },
        {},
    ]);
    expect(moved.nodes[3]).toBe(flow.nodes[3]!);
    expect(flowWithScriptsMoved(flow, 'other', 'place')).toBeUndefined();
});
