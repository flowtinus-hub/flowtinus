import { expect, test } from 'bun:test';
import { checkFlow, connectionProblem, flowFromYaml, flowToYaml, toExecutableFlow, type FlowFile } from '../../src/index';

/** Start → Loop → End; inside the Loop: Iteration start → Mapper → Iteration end */
const loopFile = (): FlowFile => ({
    version: 1,
    name: 'Pages',
    nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
            id: 'loop',
            type: 'loop',
            label: 'Pages',
            position: { x: 200, y: -100 },
            size: { width: 480, height: 272 },
            config: { maxIterations: 10, stopCondition: '$_loopIndex >= 3' },
        },
        {
            id: 'page',
            type: 'mapper',
            loop: 'loop',
            position: { x: 360, y: 0 },
            config: { fields: [{ target: 'page', value: '$_loopIndex', expression: true }] },
        },
        { id: 'end', type: 'end', position: { x: 800, y: 0 }, config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'loop', targetPort: 'in-0' },
        { source: 'loop', sourcePort: 'iteration-start', target: 'page', targetPort: 'in-0' },
        { source: 'page', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
        { source: 'loop', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

const messages = (file: FlowFile) => checkFlow(file).issues.map(i => `${i.nodeId}: ${i.message}`);

test('a flow with a Loop: valid, no cycle through Iteration start → … → Iteration end, no warnings', () => {
    const check = checkFlow(loopFile());
    expect(check.issues).toEqual([]);
    expect(check.warnings).toEqual([]);
});

test("the flow file keeps `loop` and the Loop's size through YAML, and executable flows carry `loop`", () => {
    const yaml = flowToYaml(loopFile());
    expect(yaml).toContain('loop: loop');
    const read = flowFromYaml(yaml);
    expect(read.ok).toBe(true);
    const file = read.ok ? read.value : loopFile();
    expect(file.nodes.find(n => n.id === 'page')?.loop).toBe('loop');
    expect(file.nodes.find(n => n.id === 'loop')?.size).toEqual({ width: 480, height: 272 });
    expect(toExecutableFlow(file, 'P').nodes.find(n => n.id === 'page')?.loop).toBe('loop');
    expect(toExecutableFlow(file, 'P').nodes.find(n => n.id === 'start')).not.toHaveProperty('loop');
});

test('an open region: an edge between a node inside a Loop and one outside it', () => {
    const file = loopFile();
    file.edges.push({ source: 'page', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' });
    expect(messages(file)).toContainEqual(expect.stringContaining('page: "Mapper" has an edge to "end" across a Loop\'s region'));
});

test("an inner port used from outside the Loop's region is an open region too", () => {
    const file = loopFile();
    file.edges.push({ source: 'start', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' });
    expect(messages(file)).toContainEqual(expect.stringContaining('start: "start" has an edge to "loop" across'));
});

test('a Start or End inside a Loop', () => {
    const file = loopFile();
    file.nodes.find(n => n.id === 'end')!.loop = 'loop';
    expect(messages(file)).toContainEqual(
        expect.stringContaining('end: "end" is inside the Loop "loop": the flow\'s Start and End are never inside a Loop.'),
    );
});

test('a `loop` that names no Loop, or a Loop inside itself', () => {
    const file = loopFile();
    file.nodes.find(n => n.id === 'page')!.loop = 'start';
    file.nodes.find(n => n.id === 'loop')!.loop = 'loop';
    const found = messages(file);
    expect(found).toContainEqual(expect.stringContaining('page: "Mapper" names "start" as its Loop, but that is not a Loop'));
    expect(found).toContainEqual(expect.stringContaining('loop: "Pages" is inside itself'));
});

test("a Loop's input and output take one edge each; its inner ports take several", () => {
    const file = loopFile();
    file.nodes.push({ id: 'other', type: 'mapper', position: { x: 0, y: 300 }, config: { fields: [] } });
    file.edges.push(
        { source: 'start', sourcePort: 'out-0', target: 'other', targetPort: 'in-0' },
        { source: 'other', sourcePort: 'out-0', target: 'loop', targetPort: 'in-0' },
        { source: 'loop', sourcePort: 'iteration-start', target: 'loop', targetPort: 'iteration-end' },
    );
    expect(messages(file)).toEqual(['loop: Node "loop" has input 1 with 2 connections: it takes one only.']);
});

/** the Pages Loop with an inner Loop in its region: Iteration start → Page → Inner (→ Item inside it) → Iteration end */
const nestedFile = (): FlowFile => {
    const file = loopFile();
    file.nodes.push(
        { id: 'inner', type: 'loop', label: 'Inner', loop: 'loop', position: { x: 560, y: -40 }, config: { maxIterations: 5 } },
        {
            id: 'item',
            type: 'mapper',
            loop: 'inner',
            position: { x: 600, y: 0 },
            config: { fields: [{ target: 'item', value: '$_loopIndex', expression: true }] },
        },
    );
    file.edges = file.edges.filter(e => !(e.source === 'page' && e.target === 'loop'));
    file.edges.push(
        { source: 'page', sourcePort: 'out-0', target: 'inner', targetPort: 'in-0' },
        { source: 'inner', sourcePort: 'iteration-start', target: 'item', targetPort: 'in-0' },
        { source: 'item', sourcePort: 'out-0', target: 'inner', targetPort: 'iteration-end' },
        { source: 'inner', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' },
    );
    return file;
};

test("a Loop inside a Loop's region is valid; its region is closed to the outer region too", () => {
    expect(checkFlow(nestedFile()).issues).toEqual([]);

    const open = nestedFile();
    open.edges.push({ source: 'item', sourcePort: 'out-0', target: 'loop', targetPort: 'iteration-end' });
    expect(messages(open)).toContainEqual(expect.stringContaining('item: "Mapper" has an edge to "loop" across a Loop\'s region'));
});

test('Loops that hold each other are refused (a containment cycle); what they hold is not blamed for it', () => {
    const file = nestedFile();
    file.nodes.find(n => n.id === 'loop')!.loop = 'inner';
    const found = messages(file);
    expect(found).toContainEqual(expect.stringContaining('loop: "Pages" is inside itself'));
    expect(found).toContainEqual(expect.stringContaining('inner: "Inner" is inside itself'));
    expect(found.filter(m => m.includes('inside itself'))).toHaveLength(2);
});

test('a real cycle inside a region is still a cycle', () => {
    const file = loopFile();
    file.nodes.push({ id: 'back', type: 'mapper', loop: 'loop', position: { x: 360, y: 120 }, config: { fields: [] } });
    file.edges.push(
        { source: 'page', sourcePort: 'out-0', target: 'back', targetPort: 'in-0' },
        { source: 'back', sourcePort: 'out-0', target: 'page', targetPort: 'in-0' },
    );
    expect(messages(file).some(m => m.includes('cycle'))).toBe(true);
});

test('the editor may connect Iteration start straight to Iteration end; not a component to itself', () => {
    const typeOf = (id: string) => (id === 'loop' ? 'loop' : 'mapper');
    expect(
        connectionProblem({ source: 'loop', sourcePort: 'iteration-start', target: 'loop', targetPort: 'iteration-end' }, [], typeOf),
    ).toBeUndefined();
    expect(connectionProblem({ source: 'loop', sourcePort: 'out-0', target: 'loop', targetPort: 'in-0' }, [], typeOf)).toBe(
        'A component does not connect to itself.',
    );
});

test('max iterations is required', () => {
    const file = loopFile();
    file.nodes.find(n => n.id === 'loop')!.config = {};
    expect(messages(file)).toContainEqual('loop: "Pages" has no max iterations (a whole number, 1 or more).');
});

test('a Continue with or Break outside every Loop is refused; inside one, with an input and no output, it is valid', () => {
    const inside = loopFile();
    inside.nodes.push(
        { id: 'next', type: 'continue', loop: 'loop', position: { x: 360, y: 120 }, config: {} },
        { id: 'stop', type: 'break', loop: 'loop', position: { x: 360, y: 200 }, config: {} },
    );
    inside.edges.push(
        { source: 'page', sourcePort: 'out-0', target: 'next', targetPort: 'in-0' },
        { source: 'page', sourcePort: 'out-0', target: 'stop', targetPort: 'in-0' },
    );
    expect(messages(inside)).toEqual([]);

    const outside = loopFile();
    outside.nodes.push(
        { id: 'next', type: 'continue', position: { x: 0, y: 300 }, config: {} },
        { id: 'stop', type: 'break', label: 'Stop', position: { x: 0, y: 400 }, config: {} },
    );
    expect(messages(outside)).toEqual([
        'next: "Continue with" is outside every Loop: a Continue with, Next or Break works only inside a Loop.',
        'stop: "Stop" is outside every Loop: a Continue with, Next or Break works only inside a Loop.',
    ]);
});
