import type { Edge, Node } from '@xyflow/react';
import { CARD_HEIGHT, CARD_WIDTH, FLOW_FILE_VERSION, type FlowFileNode } from '@flowtinus/core';
import { componentInfo, isFixedType } from './catalog';
import type { ComponentNode } from './component-node';
import { canvasToFlowFile, flowFileToCanvas } from './flow-file';
import { enclosingLoops, LOOP_END_TYPE, LOOP_TYPE, loopEndId, loopOfEnd, loopRegions, type LoopEndNode, type LoopNode } from './loop';

/*
 * Copy and paste of components on the canvas (Ctrl+C / Ctrl+V), through the system clipboard: the selected components
 * and the edges between them, as the core's flow file nodes and edges with a marker, so a paste in another flow or tab
 * knows them. Their settings go as they are; a pin (run data) does not. The Start and the End are not copied: a flow
 * has one of each. A Loop goes with what its box holds, and the copies inside it name the new Loop in `loop`.
 */

/** the parts of an element the focus check reads (an Element; a plain object in the tests) */
type Focused = { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null | undefined;

/**
 * Whether Ctrl+C / Ctrl+V are the canvas's (components): the focus on the page itself or on the canvas, not in a field,
 * a code editor (Monaco keeps its own selection, which the page's selection does not show), a window or anything else
 * outside the canvas.
 */
export function canvasHasFocus(active: Focused): boolean {
    if (!active || active.tagName === 'BODY' || active.tagName === 'HTML') {
        return true;
    }

    if (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName ?? '')) {
        return false;
    }

    if (active.closest?.('.monaco-editor, [role="dialog"], [contenteditable], [data-floating-window]')) {
        return false;
    }

    return Boolean(active.closest?.('.react-flow'));
}

/** what tells a paste that the clipboard holds components (and not text) */
export const CLIPBOARD_MARKER = 'flowtinus/components';

type Copied = {
    marker: typeof CLIPBOARD_MARKER;
    version: typeof FLOW_FILE_VERSION;
    nodes: FlowFileNode[];
    edges: { source: string; sourcePort: string; target: string; targetPort: string }[];
};

/** where a node is on the canvas (a node in a group has its position inside the group) */
const absolute = (node: Node, all: Node[]) => {
    const parent = node.parentId ? all.find(n => n.id === node.parentId) : undefined;
    return parent ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y } : node.position;
};

/**
 * The selected components and Loops (not the Start nor the End) and the edges between them, as clipboard text; null:
 * none. A Loop (its Loop card or its Loop end selected) takes along both cards and its region (controls and nested
 * Loops too), selected or not.
 */
export function copiedSelection(nodes: Node[], edges: Edge[]): string | null {
    const copyable = (n: Node) =>
        n.type === LOOP_TYPE || n.type === LOOP_END_TYPE || (n.type === 'component' && !isFixedType((n.data as { type: string }).type));
    const onCanvas = nodes.map(n => ({ ...n, position: absolute(n, nodes), parentId: undefined }));
    const regions = loopRegions(onCanvas, edges);
    const selectedLoops = new Set(
        nodes.filter(n => n.selected && (n.type === LOOP_TYPE || n.type === LOOP_END_TYPE)).map(n => loopOfEnd(n.id)),
    );
    const inSelectedLoop = (id: string) =>
        selectedLoops.has(loopOfEnd(id)) || enclosingLoops(id, n => regions.get(n)).some(loop => selectedLoops.has(loop));
    const copied = onCanvas.filter(n => copyable(n) && (n.selected || inSelectedLoop(n.id)));
    // a Loop goes with both its cards or not at all
    const copiedIds = new Set(copied.map(n => n.id));
    const whole = copied.filter(n =>
        n.type === LOOP_TYPE ? copiedIds.has(loopEndId(n.id)) : n.type === LOOP_END_TYPE ? copiedIds.has(loopOfEnd(n.id)) : true,
    );
    copied.splice(0, copied.length, ...whole);
    if (copied.length === 0) {
        return null;
    }

    const ids = new Set(copied.map(n => n.id));
    const file = canvasToFlowFile(
        { name: 'copy' },
        copied,
        edges.filter(e => ids.has(e.source) && ids.has(e.target)),
    );
    const copy: Copied = {
        marker: CLIPBOARD_MARKER,
        version: FLOW_FILE_VERSION,
        // no pin: it is run data, not the component
        nodes: file.nodes.map(({ pinned: _pinned, ...n }) => n),
        edges: file.edges,
    };
    return JSON.stringify(copy);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** a name not used yet on the canvas: the same, or with 2, 3... after it */
function freeLabel(label: string, used: Set<string>): string {
    if (!used.has(label)) {
        return label;
    }

    let n = 2;
    while (used.has(`${label} ${n}`)) {
        n++;
    }

    return `${label} ${n}`;
}

/**
 * The components of clipboard text, ready to add: new ids, placed as a whole (their layout kept) with their top left
 * corner at `at` (where the pointer is on this canvas) or, with `center`, their middle there (the middle of what is on
 * screen), `offset` further when pasted again at the same place; a name of their own when theirs is taken. Null when
 * the text is not copied components (then the paste is the browser's).
 */
export function pastedCopy(
    text: string,
    existing: Node[],
    at: { x: number; y: number },
    options: { offset?: number; center?: boolean } = {},
): { nodes: (ComponentNode | LoopNode | LoopEndNode)[]; edges: Edge[] } | null {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }

    if (!isObject(data) || data.marker !== CLIPBOARD_MARKER || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        return null;
    }

    // only components this editor knows, never a Start or an End
    const valid = (n: unknown): n is FlowFileNode =>
        isObject(n) &&
        typeof n.id === 'string' &&
        typeof n.type === 'string' &&
        !isFixedType(n.type) &&
        componentInfo(n.type) !== undefined &&
        isObject(n.position) &&
        typeof n.position.x === 'number' &&
        typeof n.position.y === 'number' &&
        (n.config === undefined || isObject(n.config));
    const nodes = data.nodes.filter(valid);
    if (nodes.length === 0) {
        return null;
    }

    const ids = new Map(nodes.map(n => [n.id, crypto.randomUUID()]));
    // the copy keeps its shape: it moves as a whole, its top left corner (or its middle) to `at`
    const left = Math.min(...nodes.map(n => n.position.x));
    const top = Math.min(...nodes.map(n => n.position.y));
    const width = Math.max(...nodes.map(n => n.position.x + (n.size?.width ?? CARD_WIDTH))) - left;
    const height = Math.max(...nodes.map(n => n.position.y + (n.size?.height ?? CARD_HEIGHT))) - top;
    const offset = options.offset ?? 0;
    const dx = at.x + offset - left - (options.center ? width / 2 : 0);
    const dy = at.y + offset - top - (options.center ? height / 2 : 0);
    const used = new Set(existing.flatMap(n => ((n.data as { label?: string }).label ? [(n.data as { label: string }).label] : [])));
    const renamed = nodes.map(n => {
        const label = n.label ? freeLabel(n.label, used) : undefined;
        if (label) {
            used.add(label);
        }

        // a `loop` naming a Loop not in the copy goes: where it lands, its place on this canvas says
        const { loop, ...rest } = n;
        return {
            ...rest,
            id: ids.get(n.id)!,
            label,
            config: n.config ?? {},
            position: { x: n.position.x + dx, y: n.position.y + dy },
            ...(loop && ids.has(loop) ? { loop: ids.get(loop) } : {}),
        };
    });
    const edges = (data.edges as unknown[]).filter(
        (e): e is Copied['edges'][number] =>
            isObject(e) &&
            ids.has(e.source as string) &&
            ids.has(e.target as string) &&
            typeof e.sourcePort === 'string' &&
            typeof e.targetPort === 'string',
    );
    const canvas = flowFileToCanvas({
        version: FLOW_FILE_VERSION,
        name: 'paste',
        nodes: renamed,
        edges: edges.map(e => ({ ...e, source: ids.get(e.source)!, target: ids.get(e.target)! })),
    });
    return {
        nodes: (canvas.nodes as (ComponentNode | LoopNode | LoopEndNode)[]).map(n => ({ ...n, selected: true })),
        edges: canvas.edges,
    };
}
