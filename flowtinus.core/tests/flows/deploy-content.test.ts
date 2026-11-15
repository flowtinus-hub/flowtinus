import { describe, expect, test } from 'bun:test';
import { deployContent, flowChanges, newFlowFile, type FlowFile } from '../../src/index';

/** Start → Log → End */
const flow = (): FlowFile => {
    const file = newFlowFile('Orders', 'f1');
    const start = file.nodes.find(n => n.type === 'start')!;
    const end = file.nodes.find(n => n.type === 'end')!;
    return {
        ...file,
        nodes: [...file.nodes, { id: 'log', type: 'log', label: 'Say', position: { x: 160, y: 0 }, config: { message: "'hi'" } }],
        edges: [
            { source: start.id, sourcePort: 'out-0', target: 'log', targetPort: 'in-0' },
            { source: 'log', sourcePort: 'out-0', target: end.id, targetPort: 'in-0' },
        ],
    };
};
const log = (file: FlowFile) => file.nodes.find(n => n.id === 'log')!;

describe('what a deploy compares: only what the engine takes', () => {
    test('not a change: the name, positions, notes, groups, pins, the order of components, edges and keys', () => {
        const base = deployContent(flow());
        const moved = flow();
        moved.name = 'Renamed';
        moved.nodes = moved.nodes.map(n => ({ ...n, position: { x: n.position.x + 500, y: 77 } })).reverse();
        moved.edges = [...moved.edges].reverse();
        Object.assign(log(moved), { notes: 'why it is here', pinned: { 'out-0': [{ a: 1 }] } });
        log(moved).config = { message: "'hi'" };
        moved.groups = [{ id: 'g', label: 'G', color: 'blue', position: { x: 0, y: 0 }, size: { width: 10, height: 10 } }] as never;
        expect(deployContent(moved)).toBe(base);
    });

    test('a change: a setting, a label, an edge, a component disabled', () => {
        const base = deployContent(flow());
        const changes: ((file: FlowFile) => void)[] = [
            file => (log(file).config = { message: "'bye'" }),
            file => (log(file).label = 'Shout'),
            file => file.edges.pop(),
            file => (log(file).disabled = true),
        ];
        for (const change of changes) {
            const file = flow();
            change(file);
            expect(deployContent(file)).not.toBe(base);
        }
    });
});

describe('what changed between two versions (the Compare)', () => {
    test('nothing when only the canvas changed; added, removed, changed fields and edges otherwise', () => {
        const before = flow();
        const moved = flow();
        moved.nodes = moved.nodes.map(n => ({ ...n, position: { x: 1, y: 1 }, notes: 'n' }));
        expect(flowChanges(before, moved)).toEqual({ added: [], removed: [], changed: [], edgesAdded: [], edgesRemoved: [] });

        const after = flow();
        log(after).config = { message: "'bye'", level: 'warn' };
        log(after).label = 'Shout';
        after.nodes.push({ id: 'x', type: 'limit', position: { x: 0, y: 0 }, config: {} });
        after.edges.pop();
        const changes = flowChanges(before, after);
        expect(changes.added.map(n => n.id)).toEqual(['x']);
        expect(changes.removed).toEqual([]);
        expect(changes.changed).toEqual([{ id: 'log', type: 'log', label: 'Shout', fields: ['label', 'config.level', 'config.message'] }]);
        expect(changes.edgesRemoved).toHaveLength(1);
        expect(flowChanges(after, before).removed.map(n => n.id)).toEqual(['x']);
    });
});
