import type { Node } from '@xyflow/react';
import { CARD_HEIGHT, CARD_WIDTH, DEFAULT_MAX_ITERATIONS, END, ERROR_PORT, ITERATION_END, ITERATION_START, LOOP, LOOP_BREAK, LOOP_CONTINUE_WITH, LOOP_NEXT, loopConfig, type CheckTiming, type EnvelopeData, type ErrorPolicy, type FlowFileNode, type PortEdge, START } from '@flowtinus/core';
import { portEdge } from './port-edge';

/*
 * The Loop on the canvas is two cards. The Loop card (its id is the
 * Loop's) takes the envelope from outside and starts each iteration (Iteration start); its Loop end card (id
 * `<loop>/end`) is where the paths of an iteration finish (Iteration end) and what goes out of the Loop (its output and
 * error port). Dropping a Loop from the palette adds both. The loop region is what the edges say, not geometry: every
 * component reached from Iteration start, up to Iteration end (or a Continue or Break), a nested Loop's region skipped
 * from its Loop card to its Loop end. The flow file is unchanged for the engine: one Loop node, its region in each
 * node's `loop` (ADR 0001), edges on the Loop's ports; the Loop end card's place goes in the Loop's `size` as an offset
 * from the Loop card (loopCardsOf).
 */

export const LOOP_TYPE = LOOP;

/**
 * The Loop's settings on the canvas, kept apart from the core's component settings (the Loop has a window of its own).
 * A new setting goes in: the core's loopConfig, its settings and description (loop.ts) and summary.ts; here,
 * loopConfigOf and loopDataOf; the window's changed check, Save and form (loop-window.tsx); what the Loop card
 * shows above it (loop-node.tsx) when it shows; then `bun run docs`.
 */
export type LoopData = {
    label?: string;
    maxIterations: number;
    /** an expression on the loop state and $_loopIndex: true ends the loop */
    stopCondition?: string;
    /** the stop condition before each iteration, or before each but the first (do-while) */
    checkTiming: CheckTiming;
    /** the loops of several input envelopes at the same time (PARALLEL_LOOPS at most); absent: one after another */
    parallel?: boolean;
    onError: ErrorPolicy;
    disabled?: boolean;
    notes?: string;
    /** pinned output: test runs send these envelopes per port instead of running the loop (as a component's) */
    pinned?: Record<string, EnvelopeData[]>;
    /** not a setting: its `loop` when opened or pasted (loopRegions) */
    loop?: string;
};
export type LoopNode = Node<LoopData, typeof LOOP_TYPE>;

/** the iteration's number (0 in the first), in the components inside a Loop and in its stop condition */
export const LOOP_INDEX = '$_loopIndex';

/** the Loop card and its Loop end card: a component card's size */
export const LOOP_SIZE = { width: CARD_WIDTH, height: CARD_HEIGHT };

/** the Loop end card on the canvas: its own node type, its id the Loop's with END_SUFFIX */
export const LOOP_END_TYPE = 'loop-end';
const END_SUFFIX = '/end';
export const loopEndId = (loopId: string) => `${loopId}${END_SUFFIX}`;
export const isLoopEndId = (id: string) => id.endsWith(END_SUFFIX);
/** the Loop a Loop end card belongs to; any other id as it is */
export const loopOfEnd = (id: string) => (isLoopEndId(id) ? id.slice(0, -END_SUFFIX.length) : id);
export type LoopEndNode = Node<Record<string, never>, typeof LOOP_END_TYPE>;
/** where a new Loop end goes: this far right of its Loop card (room for two cards between them) */
export const LOOP_END_GAP = 3 * CARD_WIDTH;

/**
 * Continue and Break: small components in a Loop's region, an input and no output, dragged from the Loop card's bar
 * (loop-node.tsx). The envelope that reaches Continue is the loop state of the next iteration; one that reaches
 * Break ends the loop after the iteration (it does not go out).
 */
type Placed = {
    id: string;
    type?: string;
    position: { x: number; y: number };
    width?: number;
    height?: number;
    measured?: { width?: number; height?: number };
};

/** 48 tall: centered on a card's port row by a whole grid step (CARD_HEIGHT 80), so it lines up snapped too */
export const LOOP_CONTROL_SIZE = { width: 144, height: 48 };
/** how far down a Continue with, Next or Break goes in a card's row, so its input meets the port it is fed from */
export const LOOP_CONTROL_DROP = (CARD_HEIGHT - LOOP_CONTROL_SIZE.height) / 2;
export const isLoopControl = (type: unknown) => type === LOOP_CONTINUE_WITH || type === LOOP_NEXT || type === LOOP_BREAK;
const typeOfComponent = (n: Placed) => (n.type === 'component' ? (n as { data?: { type?: unknown } }).data?.type : undefined);

/** a new Loop's settings */
export const newLoopData = (): LoopData => ({ maxIterations: DEFAULT_MAX_ITERATIONS, checkTiming: 'before', onError: 'throw' });

/** the Loop's ports: its input and Iteration start on the Loop card; Iteration end, its output and error port on the Loop end card */
export const LOOP_PORTS = {
    in: 'in-0',
    iteration: ITERATION_START,
    end: ITERATION_END,
    out: 'out-0',
    error: ERROR_PORT,
} as const;

/** a Loop's settings as the core's config (its On error is in it, as a component's) */
export function loopConfigOf(data: LoopData): Record<string, unknown> {
    return {
        maxIterations: data.maxIterations,
        ...(data.stopCondition ? { stopCondition: data.stopCondition } : {}),
        checkTiming: data.checkTiming,
        ...(data.parallel ? { parallel: true } : {}),
        onError: data.onError,
    };
}

/** a Loop of the flow file as the Loop card's settings */
export function loopDataOf(node: FlowFileNode): LoopData {
    const { maxIterations, stopCondition, checkTiming, parallel } = loopConfig(node.config);
    const onError = node.config.onError;
    return {
        ...(node.label ? { label: node.label } : {}),
        maxIterations,
        ...(stopCondition ? { stopCondition } : {}),
        checkTiming,
        ...(parallel ? { parallel: true } : {}),
        onError: onError === 'continue' || onError === 'divert' ? onError : 'throw',
        ...(node.disabled ? { disabled: true } : {}),
        ...(node.notes ? { notes: node.notes } : {}),
        ...(node.pinned && typeof node.pinned === 'object' ? { pinned: node.pinned } : {}),
    };
}

type ArrangeEdge = { id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null };
type Linked = Pick<ArrangeEdge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>;

/** the flow's Start and End are never part of a loop region */
const isStartOrEnd = (n: Placed | undefined) => {
    const type = n && typeOfComponent(n);
    return type === START || type === END;
};

/** a canvas edge as the flow file's: the Loop end card's ports are the Loop's */
export function fileEdgeOf(e: PortEdge): PortEdge {
    return { ...e, source: loopOfEnd(e.source), target: loopOfEnd(e.target) };
}

/** a flow file's edge on the canvas: the Loop's output, error port and Iteration end are on its Loop end card */
export function canvasEdgeOf(e: PortEdge, loops: Set<string>): PortEdge {
    const sourceOnEnd = loops.has(e.source) && e.sourcePort !== LOOP_PORTS.iteration;
    const targetOnEnd = loops.has(e.target) && e.targetPort === LOOP_PORTS.end;
    return { ...e, ...(sourceOnEnd ? { source: loopEndId(e.source) } : {}), ...(targetOnEnd ? { target: loopEndId(e.target) } : {}) };
}

/**
 * The Loop whose region holds each node directly, undefined outside every Loop, by the edges: from each Loop's
 * Iteration start, every node reached along the edges, stopping at its own Loop end; a nested Loop reached at its
 * input is held with its Loop end, and the walk goes on from that Loop end's outputs (what the nested Loop holds is
 * its own). A Loop end card is where its Loop is. The flow's Start and End are never held.
 */
export function loopRegions(nodes: Placed[], edges: Linked[]): Map<string, string | undefined> {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const loops = nodes.filter(n => n.type === LOOP_TYPE).map(n => n.id);
    const loopSet = new Set(loops);
    const out = new Map<string, PortEdge[]>();
    for (const e of edges.map(portEdge)) {
        out.set(e.source, [...(out.get(e.source) ?? []), e]);
    }
    const region = new Map<string, string>();
    for (const loop of loops) {
        const seen = new Set<string>();
        const queue = (out.get(loop) ?? []).filter(e => e.sourcePort === LOOP_PORTS.iteration);
        while (queue.length > 0) {
            const { target } = queue.shift()!;
            if (seen.has(target) || target === loop || target === loopEndId(loop) || isStartOrEnd(byId.get(target)) || !byId.has(target)) {
                continue;
            }
            seen.add(target);
            if (isLoopEndId(target)) {
                // another Loop's Iteration end, reached from outside its region: an edge that crosses (invalidEdges)
                continue;
            }
            if (!region.has(target)) {
                region.set(target, loop);
            }
            const next = loopSet.has(target) ? loopEndId(target) : target;
            queue.push(...(out.get(next) ?? []).filter(e => e.sourcePort !== LOOP_PORTS.iteration));
        }
    }
    const regionOf = (id: string) => (isLoopEndId(id) && loopSet.has(loopOfEnd(id)) ? region.get(loopOfEnd(id)) : region.get(id));
    return new Map(nodes.map(n => [n.id, isStartOrEnd(n) ? undefined : regionOf(n.id)]));
}

/** the Loops holding a node, the one holding it directly first and the outermost last; a cycle (a file edited by hand) ends it */
export function enclosingLoops(id: string, loopOf: (id: string) => string | undefined): string[] {
    const chain: string[] = [];
    for (let loop = loopOf(id); loop && loop !== id && !chain.includes(loop); loop = loopOf(loop)) {
        chain.push(loop);
    }
    return chain;
}

/** a Continue or Break no Loop reaches: it means nothing there (the core refuses it too) */
export function strayControl(id: string, nodes: Placed[], edges: Linked[], regions = loopRegions(nodes, edges)): boolean {
    return nodes.some(n => n.id === id && isLoopControl(typeOfComponent(n))) && !regions.get(id);
}

/** an edge between two regions: what an iteration starts and finishes, from the Loop card to its Loop end, stays inside */
export function crossesLoop(edge: PortEdge, regions: Map<string, string | undefined>): boolean {
    const sourceSide = edge.sourcePort === LOOP_PORTS.iteration && !isLoopEndId(edge.source) ? edge.source : regions.get(edge.source);
    const targetSide = edge.targetPort === LOOP_PORTS.end && isLoopEndId(edge.target) ? loopOfEnd(edge.target) : regions.get(edge.target);
    return sourceSide !== targetSide;
}

/** The ids of the canvas' edges drawn invalid (dashed red): those between two regions. */
export function invalidEdges(edges: ArrangeEdge[], nodes: Placed[]): Set<string> {
    if (!nodes.some(n => n.type === LOOP_TYPE)) {
        return new Set();
    }
    const regions = loopRegions(nodes, edges);
    return new Set(edges.filter(e => crossesLoop(portEdge(e), regions)).map(e => e.id));
}

/**
 * Why an edge may not be drawn for a Loop's sake (undefined when it may). The region follows the edges, so the new
 * edge is tried: it may not cross between two regions, nor make an edge that did not cross cross (a component of the
 * flow pulled into an iteration). Continue and Break take an edge only from inside a Loop.
 */
export function loopProblem(edge: PortEdge, nodes: Placed[], edges: Linked[] = []): string | undefined {
    const linked = (e: PortEdge): Linked => ({
        source: e.source,
        sourceHandle: e.sourcePort,
        target: e.target,
        targetHandle: e.targetPort,
    });
    const before = loopRegions(nodes, edges);
    const after = loopRegions(nodes, [...edges, linked(edge)]);
    const target = nodes.find(n => n.id === edge.target);
    if (target && isLoopControl(typeOfComponent(target)) && !after.get(edge.target)) {
        return 'Continue with, Next and Break go inside a Loop.';
    }
    const crossedBefore = (e: Linked) => crossesLoop(portEdge(e), before);
    if (crossesLoop(edge, after) || edges.some(e => !crossedBefore(e) && crossesLoop(portEdge(e), after))) {
        return 'A loop region is closed: nothing inside a Loop connects to anything outside it.';
    }
    return undefined;
}

/** a Loop's box in the files of the box version: what it held was drawn inside it */
const OLD_BOX = { width: 320, height: 192 };
const BOX_PADDING = { right: 32, left: 32 };

/**
 * Where a Loop of the flow file puts its two cards: the Loop card at its `position`, its Loop end at the `size` offset
 * from it. A file of the box version (a size at least a box's, holding the nodes that name the Loop): both cards on
 * the box's middle row, just inside its left and right edges, where Iteration start and Iteration end were.
 */
export function loopCardsOf(
    loop: { position: { x: number; y: number }; size?: { width: number; height: number } },
    members: { position: { x: number; y: number } }[],
): { start: { x: number; y: number }; end: { x: number; y: number } } {
    const { position, size } = loop;
    if (!size) {
        return { start: position, end: { x: position.x + LOOP_END_GAP, y: position.y } };
    }
    const inside = (p: { x: number; y: number }) =>
        p.x >= position.x && p.y >= position.y && p.x <= position.x + size.width && p.y <= position.y + size.height;
    if (size.width >= OLD_BOX.width && size.height >= OLD_BOX.height && members.every(m => inside(m.position))) {
        const y = Math.round((position.y + size.height / 2 - CARD_HEIGHT / 2) / 16) * 16;
        return {
            start: { x: position.x + BOX_PADDING.left, y },
            end: { x: position.x + size.width - BOX_PADDING.right - CARD_WIDTH, y },
        };
    }
    return { start: position, end: { x: position.x + size.width, y: position.y + size.height } };
}

/** the Loop end card's place as the flow file keeps it: an offset from the Loop card, in the Loop's `size` */
export const loopEndOffset = (start: { x: number; y: number }, end: { x: number; y: number }) => ({
    width: end.x - start.x,
    height: end.y - start.y,
});

type Arrangeable = Placed & { data: object; selected?: boolean; zIndex?: number };

/**
 * Arrange (arrange.ts) with Loops: each Loop card is laid out as a card with one input and one output, its Loop end as
 * one with an input, an output and its error port, so an iteration's components go between them as in any line.
 */
export function arrangeWithLoops<T extends Arrangeable, E extends ArrangeEdge>(
    nodes: T[],
    edges: E[],
    arrange: (nodes: T[], edges: E[]) => T[],
): T[] {
    // Continue with, Next and Break are laid out as a card, at the top of its row: then down to the middle of it, as a card's
    // input port. Up again before, so one alone on the top row does not move the whole layout down at each arrange.
    const moveControls = (list: T[], by: number) =>
        list.map(n => (isLoopControl(typeOfComponent(n)) ? { ...n, position: { x: n.position.x, y: n.position.y + by } } : n));
    const arrangeControls = (list: T[], links: E[]) =>
        moveControls(arrange(moveControls(list, -LOOP_CONTROL_DROP), links), LOOP_CONTROL_DROP);
    if (!nodes.some(n => n.type === LOOP_TYPE)) {
        return arrangeControls(nodes, edges);
    }
    const loops = new Map(nodes.filter(n => n.type === LOOP_TYPE).map(n => [n.id, n.data as LoopData]));
    const asCard = (n: T): T => {
        if (n.type === LOOP_TYPE) {
            return { ...n, type: 'component', data: { type: 'mapper', config: {} } };
        }
        if (n.type === LOOP_END_TYPE) {
            const onError = loops.get(loopOfEnd(n.id))?.onError === 'divert' ? 'divert' : 'throw';
            return { ...n, type: 'component', data: { type: 'mapper', config: { onError } } };
        }
        return n;
    };
    const asCardEdge = (e: E): E => ({
        ...e,
        ...(e.sourceHandle === LOOP_PORTS.iteration ? { sourceHandle: 'out-0' } : {}),
        ...(e.targetHandle === LOOP_PORTS.end ? { targetHandle: 'in-0' } : {}),
    });
    const placed = new Map(arrangeControls(nodes.map(asCard), edges.map(asCardEdge)).map(n => [n.id, n]));
    return nodes.map(n => {
        const p = placed.get(n.id);
        if (!p) {
            return n;
        }
        return n.type === LOOP_TYPE || n.type === LOOP_END_TYPE ? { ...n, position: p.position } : p;
    });
}
