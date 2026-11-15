import type { Edge, Node } from '@xyflow/react';
import { END, FLOW_FILE_VERSION, START, withoutDanglingEdges, type FlowFile, type FlowFileNode } from '@flowtinus/core';
import type { ComponentData, ComponentNode } from './component-node';
import { canvasEdgeOf, fileEdgeOf, LOOP_END_TYPE, LOOP_TYPE, loopCardsOf, loopConfigOf, loopDataOf, loopEndId, loopEndOffset, loopOfEnd, loopRegions, type LoopData, type LoopEndNode, type LoopNode } from './loop';
import { GROUP_SIZE, GROUP_Z, type GroupData, type GroupNode } from './group';
import { portEdge } from './port-edge';

/**
 * The canvas as the core's flow file (what Download gives): components and Loops, edges with their ports, groups. A
 * Loop's two cards are one Loop node (its Loop end's place in its `size`, loop.ts); a node in a loop region names its
 * Loop in `loop`.
 */
export function canvasToFlowFile(flow: { id?: string; name: string }, nodes: Node[], edges: Edge[]): FlowFile {
    const groups = nodes.filter(n => n.type === 'group');
    const regions = loopRegions(nodes, edges);
    const ends = new Map(nodes.filter(n => n.type === LOOP_END_TYPE).map(n => [n.id, n.position]));
    const inLoop = (id: string) => {
        const loop = regions.get(id);
        return loop ? { loop } : {};
    };
    const fileNodes: FlowFileNode[] = nodes.flatMap((n): FlowFileNode[] => {
        if (n.type === LOOP_TYPE) {
            const data = n.data as LoopData;
            return [
                {
                    id: n.id,
                    type: LOOP_TYPE,
                    ...(data.label?.trim() ? { label: data.label.trim() } : {}),
                    position: n.position,
                    ...(ends.has(loopEndId(n.id)) ? { size: loopEndOffset(n.position, ends.get(loopEndId(n.id))!) } : {}),
                    config: loopConfigOf(data),
                    ...(data.disabled ? { disabled: true } : {}),
                    ...(data.notes ? { notes: data.notes } : {}),
                    ...(data.pinned ? { pinned: data.pinned } : {}),
                    ...inLoop(n.id),
                },
            ];
        }
        if (n.type !== 'component') {
            return [];
        }
        const data = n.data as ComponentData;
        return [
            {
                id: n.id,
                type: data.type,
                ...(data.label?.trim() ? { label: data.label.trim() } : {}),
                position: n.position,
                config: data.config,
                ...(data.outputKey ? { outputKey: data.outputKey } : {}),
                ...(data.override ? { override: true } : {}),
                ...(data.disabled ? { disabled: true } : {}),
                ...(data.pinned ? { pinned: data.pinned } : {}),
                ...(data.notes ? { notes: data.notes } : {}),
                ...inLoop(n.id),
            },
        ];
    });
    return {
        version: FLOW_FILE_VERSION,
        ...(flow.id ? { id: flow.id } : {}),
        name: flow.name,
        nodes: fileNodes,
        edges: edges.map(e => fileEdgeOf(portEdge(e))),
        ...(groups.length
            ? {
                  groups: groups.map(g => ({
                      id: g.id,
                      title: (g.data as GroupData).title,
                      color: (g.data as GroupData).color,
                      position: g.position,
                      size: {
                          width: g.measured?.width ?? g.width ?? GROUP_SIZE.width,
                          height: g.measured?.height ?? g.height ?? GROUP_SIZE.height,
                      },
                  })),
              }
            : {}),
    };
}

/**
 * The core's flow file on the canvas (what the editor opens): groups first (behind), Start and End not deletable. A
 * Loop is its two cards, the Loop card and its Loop end (loopCardsOf); its edges on the card that has the port.
 */
export function flowFileToCanvas(file: FlowFile): {
    nodes: (ComponentNode | GroupNode | LoopNode | LoopEndNode)[];
    edges: Edge[];
} {
    const groups: GroupNode[] = (file.groups ?? []).map(g => ({
        id: g.id,
        type: 'group',
        zIndex: GROUP_Z,
        position: g.position,
        width: g.size.width,
        height: g.size.height,
        data: { title: g.title, color: g.color },
    }));
    const loops = file.nodes
        .filter(n => n.type === LOOP_TYPE)
        .flatMap((n): (LoopNode | LoopEndNode)[] => {
            const { start, end } = loopCardsOf(
                n,
                file.nodes.filter(m => m.loop === n.id),
            );
            return [
                { id: n.id, type: LOOP_TYPE, position: start, data: { ...loopDataOf(n), ...(n.loop ? { loop: n.loop } : {}) } },
                { id: loopEndId(n.id), type: LOOP_END_TYPE, position: end, data: {} },
            ];
        });
    const loopIds = new Set(file.nodes.filter(n => n.type === LOOP_TYPE).map(n => n.id));
    const components: ComponentNode[] = file.nodes
        .filter(n => n.type !== LOOP_TYPE)
        .map(n => ({
            id: n.id,
            type: 'component',
            position: n.position,
            ...(n.type === START || n.type === END ? { deletable: false } : {}),
            data: {
                type: n.type,
                config: n.config,
                ...(n.label ? { label: n.label } : {}),
                ...(n.outputKey ? { outputKey: n.outputKey } : {}),
                ...(n.override ? { override: true } : {}),
                ...(n.disabled ? { disabled: true } : {}),
                // a pin keeps its envelopes per port; a bare `true` of earlier versions had none: not pinned
                ...(n.pinned && typeof n.pinned === 'object' ? { pinned: n.pinned } : {}),
                ...(n.notes ? { notes: n.notes } : {}),
                ...(n.loop ? { loop: n.loop } : {}),
            },
        }));
    const edges: Edge[] = file.edges
        .map(fileEdge => canvasEdgeOf(fileEdge, loopIds))
        .map(e => ({
            id: `${e.source}:${e.sourcePort}->${e.target}:${e.targetPort}`,
            source: e.source,
            sourceHandle: e.sourcePort,
            target: e.target,
            targetHandle: e.targetPort,
        }));
    return { nodes: [...groups, ...loops, ...components], edges };
}

/** gives the browser a file to save */
export function saveFile(name: string, text: string, type: string): void {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
}

/**
 * The canvas' edges whose ports still exist, with the components as they are now (the core's withoutDanglingEdges): a
 * config that takes a port away (Lookup back to Null, a Router case removed, On error off Divert) takes its edges too.
 */
export function edgesWithPorts(nodes: Node[], edges: Edge[]): Edge[] {
    const components = new Map<string, { type: string; config: Record<string, unknown> }>(
        nodes.flatMap(n =>
            n.type === 'component'
                ? [[n.id, n.data as ComponentData] as const]
                : n.type === LOOP_TYPE
                  ? [[n.id, { type: LOOP_TYPE, config: loopConfigOf(n.data as LoopData) }] as const]
                  : [],
        ),
    );
    // the Loop end card's ports are its Loop's
    for (const n of nodes) {
        if (n.type === LOOP_END_TYPE && components.has(loopOfEnd(n.id))) {
            components.set(n.id, components.get(loopOfEnd(n.id))!);
        }
    }
    const nodeOf = (id: string) => {
        const data = components.get(id);
        return data ? { type: data.type, config: data.config } : undefined;
    };
    const kept = new Set(
        withoutDanglingEdges(
            edges.map(e => ({ edge: e, ...portEdge(e) })),
            nodeOf,
        ).map(e => e.edge),
    );
    return kept.size === edges.length ? edges : edges.filter(e => kept.has(e));
}
