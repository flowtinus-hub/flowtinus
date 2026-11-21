import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { deployContent, repoFlowFromYaml, repoFlowToYaml, type FlowFile } from '../../src/index';

const FLOW: FlowFile = {
    version: 1,
    id: 'f1',
    name: 'Load orders',
    nodes: [
        { id: 'end', type: 'end', position: { x: 640, y: 0 }, config: {} },
        { id: 'log', type: 'log', position: { x: 480, y: 80 }, config: { message: '$error' } },
        {
            id: 'map',
            type: 'mapper',
            label: 'Totals',
            position: { x: 320.4, y: 0 },
            config: { fields: [{ target: 'total', value: '$a', expression: true }], onError: 'divert' },
            outputKey: 'x',
            pinned: { 'out-0': [{ total: 1 }] },
            notes: 'why it is here',
        },
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: { acceptsInput: true } },
    ],
    edges: [
        { source: 'map', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
        { source: 'map', sourcePort: 'error', target: 'log', targetPort: 'in-0' },
        { source: 'start', sourcePort: 'out-0', target: 'map', targetPort: 'in-0' },
    ],
    groups: [{ id: 'g1', title: 'Read', color: '#3b82f6', position: { x: -32, y: -48 }, size: { width: 640, height: 352 } }],
};

describe('a flow file in the repository', () => {
    test('has its id, no name (it is in the path), no pinned outputs, the canvas positions and groups; deployed is left out', () => {
        const file = parse(repoFlowToYaml(FLOW));
        expect(file.id).toBe('f1');
        expect(file.version).toBe(1);
        expect(file).not.toHaveProperty('name');
        expect(file).not.toHaveProperty('deployed');
        expect(file.nodes.find((n: { id: string }) => n.id === 'map')).toEqual({
            id: 'map',
            type: 'mapper',
            label: 'Totals',
            position: { x: 320, y: 0 },
            config: { fields: [{ expression: true, target: 'total', value: '$a' }], onError: 'divert' },
            outputKey: 'x',
            notes: 'why it is here',
        });
        expect(file.groups).toEqual(FLOW.groups);
    });

    test('a locked group says locked: true and reads back locked; an unlocked one says nothing', () => {
        const locked = { ...FLOW, groups: [{ ...FLOW.groups![0]!, locked: true }] };
        expect(parse(repoFlowToYaml(locked)).groups[0].locked).toBe(true);
        expect(parse(repoFlowToYaml(FLOW)).groups[0]).not.toHaveProperty('locked');
        expect(repoFlowFromYaml(repoFlowToYaml(locked), 'Load orders')).toMatchObject({
            ok: true,
            value: { flow: { groups: [{ id: 'g1', locked: true }] } },
        });
    });

    test('an undeployed flow says deployed: false', () => {
        expect(parse(repoFlowToYaml(FLOW, { deployed: false })).deployed).toBe(false);
    });

    test('reads back with the name its path gives; deployed is true when absent', () => {
        const read = repoFlowFromYaml(repoFlowToYaml(FLOW), 'Load orders');
        expect(read).toEqual({
            ok: true,
            value: {
                flow: {
                    ...FLOW,
                    nodes: FLOW.nodes.map(({ pinned: _pinned, ...n }) => (n.id === 'map' ? { ...n, position: { x: 320, y: 0 } } : n)),
                },
                deployed: true,
            },
        });
        expect(repoFlowFromYaml(repoFlowToYaml(FLOW, { deployed: false }), 'Load orders')).toMatchObject({
            ok: true,
            value: { deployed: false },
        });
    });

    test('the name of the path wins over a name in the file; pinned outputs in the file are dropped', () => {
        const text = repoFlowToYaml(FLOW).replace('id: f1', 'id: f1\nname: Other');
        const read = repoFlowFromYaml(text, 'Load orders');
        expect(read.ok && read.value.flow.name).toBe('Load orders');
        const pinned = `${repoFlowToYaml(FLOW)}`.replace('    outputKey: x', '    outputKey: x\n    pinned: { out-0: [{ a: 1 }] }');
        const back = repoFlowFromYaml(pinned, 'Load orders');
        expect(back.ok && back.value.flow.nodes.find(n => n.id === 'map')).not.toHaveProperty('pinned');
    });

    test('refused: no id (the error gives one to paste), a deployed that is not a boolean, an invalid flow', () => {
        const noId = repoFlowFromYaml(repoFlowToYaml(FLOW).replace('id: f1\n', ''), 'Load orders');
        expect(noId.ok).toBe(false);
        expect(!noId.ok && noId.errors[0]).toMatch(/^The flow has no id: add one, such as "id: [0-9a-f-]{36}"\.$/);
        expect(repoFlowFromYaml(`${repoFlowToYaml(FLOW)}deployed: maybe\n`, 'Load orders')).toEqual({
            ok: false,
            errors: ['"deployed" is true or false.'],
        });
        expect(repoFlowFromYaml('version: 1\nid: f1\nnodes: []\nedges: []\n', 'Load orders')).toMatchObject({
            ok: false,
            errors: ['The flow needs exactly one Start (it has 0).', 'The flow needs exactly one End (it has 0).'],
        });
        expect(repoFlowFromYaml('nodes: [', 'Load orders')).toMatchObject({ ok: false });
    });
});

const CANONICAL = `version: 1
id: f1
nodes:
  - id: end
    type: end
    position:
      x: 640
      y: 0
    config: {}
  - id: log
    type: log
    position:
      x: 480
      y: 80
    config:
      level: warn
      message: $error
  - id: map
    type: mapper
    position:
      x: 320
      y: 0
    config:
      fields:
        - expression: true
          target: total
          value: |-
            $a +
            $b
      onError: divert
    notes: why it is here
  - id: start
    type: start
    position:
      x: 0
      y: 0
    config: {}
edges:
  - source: map
    sourcePort: out-0
    target: end
    targetPort: in-0
  - source: map
    sourcePort: error
    target: log
    targetPort: in-0
  - source: start
    sourcePort: out-0
    target: map
    targetPort: in-0
groups:
  - id: a
    title: A
    color: red
    position:
      x: 0
      y: 0
    size:
      width: 10
      height: 10
  - id: b
    title: B
    color: blue
    position:
      x: 0
      y: 0
    size:
      width: 10
      height: 10
`;

const HAND_WRITTEN = [
    '# written by hand',
    'edges:',
    '  - { target: map, targetPort: in-0, source: start, sourcePort: out-0 }',
    '  - { source: map, sourcePort: out-0, target: end, targetPort: in-0 }',
    '  - { source: map, sourcePort: error, target: log, targetPort: in-0 }',
    'groups:',
    '  - { id: b, title: B, color: blue, position: { x: 0, y: 0 }, size: { width: 10, height: 10 } }',
    '  - { id: a, title: A, color: red, position: { x: 0, y: 0 }, size: { width: 10, height: 10 } }',
    'id: "f1"',
    'nodes:',
    '  - { id: start, type: start, position: { x: 0, y: 0 } }',
    '  - id: map',
    '    notes: why it is here',
    '    config:',
    '      onError: divert',
    '      fields:',
    '        - value: |-',
    '            $a +',
    '            $b',
    '          target: total',
    '          expression: true',
    '    position: { y: 0, x: 320 }',
    '    type: mapper',
    '  - { id: log, type: log, position: { x: 480, y: 80 }, config: { message: $error, level: warn } } # the errors',
    '  - { id: end, type: end, position: { x: 640, y: 0 }, config: {} }',
    'version: 1',
    '',
].join('\r\n');

describe('the stable order', () => {
    test('a file in any order and formatting (flow style, CRLF, comments) is read, and written in the canonical order', () => {
        const read = repoFlowFromYaml(HAND_WRITTEN, 'Load orders');
        expect(read.ok).toBe(true);
        expect(read.ok && repoFlowToYaml(read.value.flow)).toBe(CANONICAL);
    });

    test('writing what was read gives no diff', () => {
        const read = repoFlowFromYaml(CANONICAL, 'Load orders');
        expect(read.ok && repoFlowToYaml(read.value.flow)).toBe(CANONICAL);
    });

    test('a flow as Postgres gives it back (keys in its own order) writes the same text', () => {
        const read = repoFlowFromYaml(CANONICAL, 'Load orders');
        if (!read.ok) {
            throw new Error(read.errors.join('\n'));
        }
        const reversed = (value: unknown): unknown =>
            Array.isArray(value)
                ? value.map(reversed)
                : value && typeof value === 'object'
                  ? Object.fromEntries(
                        Object.entries(value)
                            .reverse()
                            .map(([k, v]) => [k, reversed(v)]),
                    )
                  : value;
        expect(repoFlowToYaml(reversed(read.value.flow) as FlowFile)).toBe(CANONICAL);
    });
});

describe("a version's content (what its hash is taken over)", () => {
    const content = (text: string) => {
        const read = repoFlowFromYaml(text, 'Load orders');
        if (!read.ok) {
            throw new Error(read.errors.join('\n'));
        }
        return deployContent(read.value.flow);
    };

    test('leaves out deployed', () => {
        expect(content(repoFlowToYaml(FLOW, { deployed: false }))).toBe(content(repoFlowToYaml(FLOW)));
    });

    test('is the same over LF and CRLF, in the file and inside a value', () => {
        const lf = content(CANONICAL);
        expect(content(CANONICAL.replaceAll('\n', '\r\n'))).toBe(lf);
        expect(content(CANONICAL.replace('message: $error', 'message: "$error\\nnext"'))).toBe(
            content(CANONICAL.replace('message: $error', 'message: "$error\\r\\nnext"')),
        );
        expect(content(CANONICAL.replace('message: $error', 'message: "$error\\nnext"'))).not.toBe(lf);
    });
});
