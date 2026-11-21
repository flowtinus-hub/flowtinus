import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { addEdge, Background, BackgroundVariant, MiniMap, Panel, ReactFlow, SelectionMode, useEdgesState, useNodesState, type Connection, type Edge, type FitViewOptions, type ReactFlowInstance, type XYPosition } from '@xyflow/react';
import { LoaderCircle, Network, Redo2, SquareDashed, Undo2, X } from 'lucide-react';
import { useParams } from 'react-router';
import { ProjectResourcesContext, ScriptGlobalsContext, useLoadProjectResources } from '@/editor/project-resources';
import { Button } from '@/components/ui/button';
import '@xyflow/react/dist/style.css';
import { CARD_HEIGHT, CARD_WIDTH, cardWidth, COMPONENT_TYPE, componentSettings, connectionProblem, flowCalls, flowScriptUses, scriptCodeOf, type FlowCall, type ScriptUse, dataTypeFromSamples, END, fixedOnError, inputVariables, scriptGlobals, settingsDefaults, START, startParameters, systemVariables, type EnvelopeData, type KnownVariables } from '@flowtinus/core';
import { arrange } from '@/editor/arrange';
import { bridges, edgesAfterDelete } from '@/editor/bridge-delete';
import { CATEGORIES, componentInfo, isFixedType } from '@/editor/catalog';
import type { ComponentDraft } from '@/editor/component-draft';
import { ComponentWindow } from '@/editor/component-window';
import { FloatingWindow, type WindowPosition, type WindowSize } from '@/editor/floating-window';
import { readViewport, readWindow, rememberViewport, rememberWindow } from '@/editor/window-memory';
import { cn } from '@/lib/utils';
import { readPaletteOpen, savePaletteOpen } from '@/lib/view-preference';
import { editing } from '@/editor/read-only';
import { useFlowDraft, type DraftSave } from '@/editor/flow-save';
import { edgesWithPorts } from '@/editor/flow-file';
import { portEdge } from '@/editor/port-edge';
import { RunFromContext, RunMarksContext, type RunMarks } from '@/editor/run/run-marks';
import { ExpressionVariablesContext, type InputSamples } from '@/editor/expression-variables';
import { ComponentNodeMemo, type ComponentData, type ComponentNode } from '@/editor/component-node';
import { COMPONENT_DRAG_TYPE } from '@/editor/drag';
import { canSplice, edgePoints, edgeUnder, pointerBox, splice } from '@/editor/edge-splice';
import { crossedEdges } from '@/editor/edge-cut';
import { GROUP_COLORS, GROUP_SIZE, GROUP_Z, layerGroups, type GroupNode } from '@/editor/group';
import { GroupNodeMemo } from '@/editor/group-node';
import { arrangeWithLoops, fileEdgeOf, invalidEdges, LOOP_END_GAP, LOOP_END_TYPE, LOOP_TYPE, loopEndId, loopOfEnd, loopProblem, loopRegions, LOOP_INDEX, LOOP_PORTS, newLoopData, type LoopData, type LoopEndNode, type LoopNode } from '@/editor/loop';
import { LoopEndNodeMemo, LoopNodeMemo } from '@/editor/loop-node';
import { LoopWindow } from '@/editor/loop-window';
import { HistoryContext, isEditableField, shortcutsBusy, UndoStack } from '@/editor/history';
import { canvasHasFocus, copiedSelection, pastedCopy } from '@/editor/clipboard';
import { preloadCodeEditor } from '@/editor/code-editor-loader';
import { ComponentPalette, PALETTE_RAIL, PALETTE_WIDTH } from './component-palette';
import { FIT_TO_SCREEN } from '@/editor/fit';
import { ZoomControls } from './zoom-controls';
import { ShortcutsDialog } from './shortcuts-dialog';

/** the grid: a small dot every DOT_GAP px (--grid on --canvas in index.css) */
const DOT_GAP = 16;
const DOT_SIZE = 1.5;
/** how far a paste lands from what was copied (one grid step more each paste) */
const PASTE_OFFSET = 32;

/** the pointer while X is held (the cut): scissors (lucide's), dark lines on a white outline so they show on both themes */
const SCISSORS_CURSOR = (() => {
    const shapes =
        '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>';
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
        `<g stroke="white" stroke-width="4">${shapes}</g><g stroke="black" stroke-width="2">${shapes}</g></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
})();

const NO_CALLS = JSON.stringify({ calls: [], scripts: [] });

const NODE_TYPES = { component: ComponentNodeMemo, group: GroupNodeMemo, [LOOP_TYPE]: LoopNodeMemo, [LOOP_END_TYPE]: LoopEndNodeMemo };

/** what the canvas holds: components, Loops (two cards each, editor/loop.ts) and groups behind them */
type FlowNode = ComponentNode | GroupNode | LoopNode | LoopEndNode;

/** what the page does with the canvas: read it as it is now (Download, Run), focus a component, pin its output */
export type CanvasHandle = {
    snapshot: () => { nodes: FlowNode[]; edges: Edge[] };
    focus: (nodeId: string) => void;
    /** pins the component with these envelopes per port (what went out of it in the run), or unpins it (undefined) */
    setPinned: (nodeId: string, pinned: Record<string, EnvelopeData[]> | undefined) => void;
};

const isComponent = (node: FlowNode): node is ComponentNode => node.type === 'component';

/** what Ctrl+Z goes back to */
type Snapshot = { nodes: FlowNode[]; edges: Edge[] };

/** on the minimap each component in its category's color, a group as a tint of its own */
const minimapColor = (node: FlowNode) => {
    if (node.type === LOOP_TYPE || node.type === LOOP_END_TYPE) {
        return CATEGORIES.flow.color;
    }
    if (node.type === 'group') {
        return `color-mix(in oklch, ${node.data.color} 25%, transparent)`;
    }

    const info = componentInfo(node.data.type);
    return info ? CATEGORIES[info.category].color : 'var(--muted-foreground)';
};

/** what a window or its chip shows for a node: a component's info, or the Loop's; nothing for a group */
const windowInfo = (node: FlowNode | undefined) =>
    !node ? undefined : node.type === LOOP_TYPE ? componentInfo(LOOP_TYPE) : isComponent(node) ? componentInfo(node.data.type) : undefined;

/** a node's type for the core's port rules: a component's, or the Loop's (both its cards) */
const coreTypeOf = (node: FlowNode | undefined) =>
    !node ? undefined : node.type === LOOP_TYPE || node.type === LOOP_END_TYPE ? LOOP_TYPE : isComponent(node) ? node.data.type : undefined;

/** the name given to a component or a Loop */
const labelOf = (node: FlowNode) => (isComponent(node) || node.type === LOOP_TYPE ? node.data.label?.trim() : undefined);

/** what fits the flow on screen: room on the left for the components panel, never past 100% */
const FIT_VIEW: FitViewOptions<FlowNode> = { maxZoom: 1, padding: { top: '96px', right: '64px', bottom: '96px', left: '320px' } };

/** a new flow: its Start and End, as in the PoC (they cannot be deleted; the canvas has nothing else to begin with) */
const FIXED_NODES: ComponentNode[] = [
    { id: START, type: 'component', position: { x: 0, y: 0 }, deletable: false, data: { type: START, config: {} } },
    { id: END, type: 'component', position: { x: 4 * CARD_WIDTH, y: 0 }, deletable: false, data: { type: END, config: {} } },
];

/**
 * The flow's canvas: the dotted grid, the floating components panel, and the components dragged from it. Ports connect
 * output → input (the core's rules); a new component dropped from the palette on an edge goes into it; Delete or
 * Backspace removes what is selected. Pan with the middle/right
 * button or the scroll, zoom with Ctrl + scroll. What it holds is saved as the flow's draft (flow-save.ts).
 */
/** the size a window with a code editor or a table opens with */
const WIDE_WINDOW = { w: 760, h: null };

const noRunFrom = () => {};
const NO_EDGES: Edge[] = [];

/**
 * The edges as bridge-delete.ts sees them when whole Loops go (`going` holds both cards): each Loop one component, its
 * input on the Loop card and its output on the Loop end, the iteration's edges left out (no bridge into an iteration).
 */
function loopAsOne(going: Set<string>, edges: Edge[]): Edge[] {
    return edges
        .filter(
            e =>
                !(going.has(e.source) && e.sourceHandle === LOOP_PORTS.iteration) &&
                !(going.has(e.target) && e.targetHandle === LOOP_PORTS.end),
        )
        .map(e =>
            going.has(e.source) && going.has(loopOfEnd(e.source)) && e.source !== loopOfEnd(e.source)
                ? { ...e, source: loopOfEnd(e.source) }
                : e,
        );
}

export function FlowCanvas(props: {
    exportRef?: RefObject<CanvasHandle | null>;
    onSave?: (save: DraftSave) => void;
    marks?: RunMarks | null;
    /** the components whose output is pinned, each time that changes (the run's Data tab shows Pin or Unpin) */
    onPinned?: (nodeIds: string[]) => void;
    /** what the runs so far saw going out of each port (expression fields suggest it) */
    known?: KnownVariables;
    /** the envelopes the runs saw reaching each component (a TypeScript component's Data type) */
    inputSamples?: InputSamples;
    /** Run from here on a component */
    onRunFrom?: (nodeId: string) => void;
    /** B: opens or closes the run's panel */
    onToggleRunPanel?: () => void;
    /** D: opens or closes the Calls panel (`toolsBefore`) */
    onToggleCalls?: () => void;
    /** this flow's calls (its Flow Invokers), each time one is added, removed or changed (the Calls panel) */
    onCalls?: (calls: FlowCall[]) => void;
    /** the scripts this flow's components import, as the canvas has them now (the Calls panel's Scripts) */
    onScriptUses?: (uses: ScriptUse[]) => void;
    /** an archived flow: shown to read (pan, zoom), nothing changes and nothing is saved */
    readOnly?: boolean;
    onHeldEdit?: () => void;
    /** the tools before Group (Calls), shown on a read-only flow too */
    toolsBefore?: ReactNode;
    /** the first of the tools on the right (the flow's worker tag) */
    tools?: ReactNode;
    /** the tools on the right after it (Deploy, Schedules, Webhooks) */
    toolsAfter?: ReactNode;
}) {
    const {
        exportRef,
        onSave,
        marks = null,
        onPinned,
        known,
        inputSamples,
        onRunFrom = noRunFrom,
        onToggleRunPanel,
        onToggleCalls,
        onCalls,
        onScriptUses,
        readOnly = false,
        onHeldEdit,
        toolsBefore,
        tools,
        toolsAfter,
    } = props;
    const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(FIXED_NODES);
    // the components drawer, open or closed (remembered in this browser)
    const [paletteOpen, setPaletteOpen] = useState(readPaletteOpen);
    const togglePalette = (open: boolean) => {
        setPaletteOpen(open);
        savePaletteOpen(open);
    };
    // the strip of tools starts after the drawer (none on a read-only flow)
    const palette = readOnly ? 0 : PALETTE_RAIL + (paletteOpen ? PALETTE_WIDTH : 0);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    // what the page's Download takes: the canvas as it is now
    const [flow, setFlow] = useState<ReactFlowInstance<FlowNode, Edge> | null>(null);
    const { flowId = '', projectId = '' } = useParams();

    // ---- the draft on the server (editor/flow-save.ts): opened here, saved by itself; the view comes back where it was
    const opened = useRef<{ nodes: FlowNode[]; edges: Edge[] } | null>(null);
    const draft = useFlowDraft(
        flowId,
        { nodes, edges },
        loaded => {
            opened.current = loaded;
            setNodes(loaded.nodes);
            setEdges(loaded.edges);
        },
        readOnly,
        onHeldEdit,
    );
    // the flow on screen: every node of the opened draft drawn and measured, and the view set (the overlay goes then); kept
    // per flow, so opening another one veils the canvas again
    const [shownFor, setShownFor] = useState<string | null>(null);
    // once the draft is on the canvas and the canvas is ready: the remembered view, or the whole flow on screen
    useEffect(() => {
        if (!flow || !opened.current || draft.state.status === 'loading') {
            return;
        }

        // the draft stays "opened" until the view is set: a status change (saving, saved) cancels this run and the next
        // one starts again
        const view = readViewport(flowId);
        let frame = 0;
        // never more than about 10 s under the veil, whatever is not measured
        const giveUp = performance.now() + 10_000;
        // React Flow measures each node after drawing it: wait for all of them (a big flow takes a while), then the view
        const whenMeasured = () => {
            if (!flow.getNodes().every(n => n.hidden || n.measured?.width !== undefined) && performance.now() < giveUp) {
                frame = requestAnimationFrame(whenMeasured);
                return;
            }
            opened.current = null;
            void Promise.resolve(view ? flow.setViewport(view) : flow.fitView(FIT_VIEW)).then(() => setShownFor(flowId));
        };
        frame = requestAnimationFrame(whenMeasured);
        return () => cancelAnimationFrame(frame);
    }, [flow, flowId, draft.state.status]);
    useEffect(() => {
        onSave?.(draft);
    }, [onSave, draft]);
    // while the flow opens, nothing on the canvas (not the new flow's Start and End): an overlay says it is opening, until
    // the flow is drawn and in view
    const opening = draft.state.status === 'loading';
    const veiled = opening || (shownFor !== flowId && draft.state.status !== 'error');
    // a smaller group above a bigger one, so a group inside another can be clicked
    const shownNodes = useMemo(() => (opening ? [] : layerGroups(nodes)), [nodes, opening]);

    // ---- Ctrl+Z / Ctrl+Y (editor/history.ts): each change saves the canvas first
    const [stack] = useState(() => new UndoStack<Snapshot>());
    const [steps, setSteps] = useState({ undo: false, redo: false });
    const synced = useCallback(() => setSteps({ undo: stack.canUndo, redo: stack.canRedo }), [stack]);
    const snapshot = useCallback(
        (): Snapshot => ({ nodes: flow?.getNodes() ?? nodes, edges: flow?.getEdges() ?? edges }),
        [flow, nodes, edges],
    );
    const record = useCallback(() => {
        stack.record(snapshot());
        synced();
    }, [stack, snapshot, synced]);
    const recordEdit = useCallback(
        (key: string) => {
            stack.recordEdit(snapshot(), key);
            synced();
        },
        [stack, snapshot, synced],
    );
    const restore = useCallback(
        (state: Snapshot | undefined) => {
            if (state) {
                setNodes(state.nodes);
                setEdges(state.edges);
            }

            synced();
        },
        [setNodes, setEdges, synced],
    );
    const undo = useCallback(() => restore(stack.undo(snapshot())), [restore, stack, snapshot]);
    const redo = useCallback(() => restore(stack.redo(snapshot())), [restore, stack, snapshot]);
    const history = useMemo(() => ({ record, recordEdit }), [record, recordEdit]);

    // the Flow Invokers' calls and the scripts the components import, told again only when they change (not on a move)
    const callsKey = useMemo(() => {
        const relevant = nodes
            .filter(isComponent)
            .some(
                n =>
                    n.data.type === COMPONENT_TYPE.flowInvoker ||
                    scriptCodeOf(n.data.type, n.data.config) !== undefined ||
                    componentSettings(n.data.type).some(f => f.kind === 'script-type'),
            );
        if (!relevant) {
            return NO_CALLS;
        }

        const executable = {
            project: '',
            flow: '',
            parameters: [],
            nodes: nodes.filter(isComponent).map(n => ({
                id: n.id,
                type: n.data.type,
                label: n.data.label || componentInfo(n.data.type)?.label || n.data.type,
                config: n.data.config,
            })),
            edges: edges.map(portEdge),
        };
        const own = { ...executable, id: flowId };
        return JSON.stringify({ calls: flowCalls([own]), scripts: flowScriptUses([own]) });
    }, [nodes, edges, flowId]);
    useEffect(() => {
        const { calls, scripts } = JSON.parse(callsKey) as { calls: FlowCall[]; scripts: ScriptUse[] };
        onCalls?.(calls);
        onScriptUses?.(scripts);
    }, [onCalls, onScriptUses, callsKey]);

    const pinnedKey = nodes
        .filter(n => (isComponent(n) || n.type === LOOP_TYPE) && n.data.pinned)
        .map(n => n.id)
        .join(',');
    useEffect(() => {
        onPinned?.(pinnedKey ? pinnedKey.split(',') : []);
    }, [onPinned, pinnedKey]);

    // the page's handle on the canvas (CanvasHandle)
    useEffect(() => {
        if (exportRef) {
            exportRef.current = {
                snapshot: () => ({ nodes, edges }),
                // the component in the middle of the screen, selected (a click on a log line or a row of the run)
                focus: nodeId => {
                    const node = nodes.find(n => n.id === nodeId);
                    if (!node || !flow) {
                        return;
                    }

                    setNodes(current => current.map(n => ({ ...n, selected: n.id === nodeId })));
                    const width = cardWidth(String((node.data as { type?: unknown }).type ?? ''));
                    void flow.setCenter(node.position.x + width / 2, node.position.y + CARD_HEIGHT / 2, {
                        zoom: Math.max(flow.getZoom(), 1),
                        duration: 300,
                    });
                },
                // pinning from the run's Data tab, as the bar's Pin does (one Ctrl+Z step): the envelopes it keeps, or none
                setPinned: (nodeId, pinned) => {
                    record();
                    setNodes(current =>
                        current.map(n =>
                            n.id === nodeId && (isComponent(n) || n.type === LOOP_TYPE)
                                ? ({ ...n, data: { ...n.data, pinned } } as FlowNode)
                                : n,
                        ),
                    );
                },
            };
        }
    }, [exportRef, nodes, edges, flow, setNodes, record]);

    // Ctrl+S saves now (anywhere, as in any editor); Ctrl+Z undoes; Ctrl+Y or Ctrl+Shift+Z redoes (Cmd on a Mac); typing
    // in a field keeps the field's own undo
    const saveNow = draft.saveNow;
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey)) {
                return;
            }

            const key = event.key.toLowerCase();
            if (key === 's') {
                event.preventDefault();
                saveNow();
                return;
            }

            if (isEditableField(event.target) || readOnly) {
                return;
            }

            if (key === 'z' && !event.shiftKey) {
                event.preventDefault();
                undo();
            } else if ((key === 'z' && event.shiftKey) || key === 'y') {
                event.preventDefault();
                redo();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [undo, redo, saveNow, readOnly]);

    // the code editor (Monaco) in the background: a window with code opens with it at once
    useEffect(preloadCodeEditor, []);

    // Ctrl+C with components selected copies them (editor/clipboard.ts); Ctrl+V pastes them, a little further each time.
    // Typing in a field, or text selected on the page: the browser's own copy and paste
    const pastes = useRef<{ at: { x: number; y: number } | null; count: number }>({ at: null, count: 0 });
    // the pointer over the canvas (screen coordinates), null once it left: a paste lands there
    const pointer = useRef<{ x: number; y: number } | null>(null);
    useEffect(() => {
        const busy = () => !canvasHasFocus(document.activeElement) || Boolean(window.getSelection()?.toString());
        const onCopy = (event: ClipboardEvent) => {
            if (busy() || !event.clipboardData) {
                return;
            }

            const text = copiedSelection(nodes, edges);
            if (text) {
                event.preventDefault();
                event.clipboardData.setData('text/plain', text);
                pastes.current = { at: null, count: 0 };
            }
        };
        const onPaste = (event: ClipboardEvent) => {
            if (readOnly || !canvasHasFocus(document.activeElement) || !event.clipboardData) {
                return;
            }

            // at the pointer on the canvas; away from it, in the middle of what is on screen (snapped to the grid). Again at
            // the same place: a step further, so the copies do not hide each other
            const box = document.querySelector('.react-flow')?.getBoundingClientRect();
            const point = pointer.current ?? (box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null);
            const spot = flow && point ? flow.screenToFlowPosition(point) : { x: 0, y: 0 };
            const snap = (value: number) => Math.round(value / DOT_GAP) * DOT_GAP;
            const at = { x: snap(spot.x), y: snap(spot.y) };
            const again = pastes.current.at?.x === at.x && pastes.current.at?.y === at.y;
            const count = again ? pastes.current.count + 1 : 0;
            const pasted = pastedCopy(event.clipboardData.getData('text/plain'), nodes, at, {
                offset: PASTE_OFFSET * count,
                center: !pointer.current,
            });
            if (!pasted) {
                return;
            }

            event.preventDefault();
            pastes.current = { at, count };
            record();
            setNodes(current => [...current.map(n => ({ ...n, selected: false })), ...pasted.nodes]);
            setEdges(current => [...current, ...pasted.edges]);
        };
        window.addEventListener('copy', onCopy);
        window.addEventListener('paste', onPaste);
        return () => {
            window.removeEventListener('copy', onCopy);
            window.removeEventListener('paste', onPaste);
        };
    }, [nodes, edges, record, setNodes, setEdges, flow, readOnly]);

    const onConnect = useCallback(
        (connection: Connection) => {
            record();
            setEdges(current => addEdge(connection, current));
        },
        [record, setEdges],
    );

    // who may connect to what is the core's rule (connectionProblem): one edge per port but the Start's output and the
    // End's input, never Start straight to End, never the same two ports twice
    const isValidConnection = useCallback(
        (connection: Connection | Edge) => {
            const typeOf = (id: string) => coreTypeOf((flow?.getNode(id) as FlowNode | undefined) ?? nodes.find(n => n.id === id));
            const asPorts = (e: Connection | Edge) => ({
                source: e.source,
                sourcePort: e.sourceHandle ?? '',
                target: e.target,
                targetPort: e.targetHandle ?? '',
            });
            // a loop region is closed (editor/loop.ts)
            if (loopProblem(asPorts(connection), flow?.getNodes() ?? nodes, flow?.getEdges() ?? edges)) {
                return false;
            }
            return !connectionProblem(asPorts(connection), edges.map(asPorts), typeOf);
        },
        [edges, flow, nodes],
    );

    // ---- drop on an edge (editor/edge-splice.ts): only a NEW component, dragged from the palette. The edge under the
    // pointer is highlighted and the component dropped there goes into it; moving a component already on the canvas over
    // an edge does neither
    const [spliceEdge, setSpliceEdge] = useState<string | null>(null);
    const shownEdges = useMemo(() => {
        const invalid = invalidEdges(edges, nodes);
        return edges.map(e => {
            const className = [e.id === spliceEdge && 'is-splice-target', invalid.has(e.id) && 'is-invalid-edge'].filter(Boolean).join(' ');
            return className ? { ...e, className } : e;
        });
    }, [edges, spliceEdge, nodes]);
    const typeOfNode = useCallback(
        (id: string) => {
            return coreTypeOf((flow?.getNode(id) as FlowNode | undefined) ?? nodes.find(n => n.id === id));
        },
        [flow, nodes],
    );
    const edgeAt = (clientX: number, clientY: number, nodeId?: string) =>
        flow ? edgeUnder(pointerBox(flow.screenToFlowPosition({ x: clientX, y: clientY })), edges, nodeId) : undefined;
    const spliceInto = (edge: Edge | undefined, node: ComponentNode) => {
        if (edge && canSplice(node, edges)) {
            setEdges(current => splice(current, edge, node.id, typeOfNode) ?? current);
        }
    };

    const onDragOver = (event: DragEvent) => {
        if (event.dataTransfer.types.includes(COMPONENT_DRAG_TYPE)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            const id = edgeAt(event.clientX, event.clientY)?.id ?? null;
            if (id !== spliceEdge) {
                setSpliceEdge(id);
            }
        }
    };

    const onDrop = (event: DragEvent) => {
        const type = event.dataTransfer.getData(COMPONENT_DRAG_TYPE);
        if (!type || !flow || readOnly) {
            return;
        }

        event.preventDefault();
        record();
        const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        // a Loop: its two cards (editor/loop.ts), the Loop card where it is dropped and its Loop end a few cards to the right
        if (type === LOOP_TYPE) {
            const at = { x: Math.round(position.x / DOT_GAP) * DOT_GAP, y: Math.round((position.y - 32) / DOT_GAP) * DOT_GAP };
            const id = crypto.randomUUID();
            const loop: LoopNode = { id, type: LOOP_TYPE, selected: true, position: at, data: newLoopData() };
            const end: LoopEndNode = {
                id: loopEndId(id),
                type: LOOP_END_TYPE,
                selected: true,
                position: { x: at.x + LOOP_END_GAP, y: at.y },
                data: {},
            };
            setNodes(current => [...current.map(n => ({ ...n, selected: false })), loop, end]);
            setSpliceEdge(null);
            return;
        }
        // the pointer at the card's left middle, snapped to the grid
        const topLeft = { x: position.x, y: position.y - 32 };
        const node: ComponentNode = {
            id: crypto.randomUUID(),
            type: 'component',
            position: { x: Math.round(topLeft.x / DOT_GAP) * DOT_GAP, y: Math.round(topLeft.y / DOT_GAP) * DOT_GAP },
            data: { type, config: settingsDefaults(componentSettings(type)) },
            selected: true,
        };
        setNodes(current => [...current.map(n => ({ ...n, selected: false })), node]);
        setSpliceEdge(null);
        // on an edge: goes into it
        spliceInto(edgeAt(event.clientX, event.clientY), node);
    };

    // a new group in the middle of what is on screen, behind everything, with the next color of the list
    const addGroup = () => {
        if (!flow) {
            return;
        }

        const box = document.querySelector('.react-flow')?.getBoundingClientRect();
        const center = box ? flow.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 };
        record();
        const snap = (value: number) => Math.round(value / DOT_GAP) * DOT_GAP;
        const group: GroupNode = {
            id: crypto.randomUUID(),
            type: 'group',
            selected: true,
            zIndex: GROUP_Z,
            ...GROUP_SIZE,
            position: { x: snap(center.x - GROUP_SIZE.width / 2), y: snap(center.y - GROUP_SIZE.height / 2) },
            data: { title: '', color: GROUP_COLORS[nodes.filter(n => n.type === 'group').length % GROUP_COLORS.length]! },
        };
        setNodes(current => [group, ...current.map(n => ({ ...n, selected: false }))]);
    };

    // Arrange: the components left to right, glued (editor/arrange.ts), then the whole flow on screen
    const arrangeFlow = () => {
        record();
        setNodes(current => arrangeWithLoops(current, edges, arrange));
        window.setTimeout(() => void flow?.fitView({ ...FIT_VIEW, duration: 200 }), 0);
    };

    // ---- the canvas' keys: A arranges, C opens or closes the components, G adds a group, F fits the flow to the screen,
    // B opens or closes the run's panel, D the Calls panel, K shows the shortcuts; X held arms the cut (below). Not while
    // typing in a field or in a window, nor with Ctrl, Alt, Shift or Cmd (those are other shortcuts). A read-only flow
    // takes only F, B, D and K
    const [cutArmed, setCutArmed] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    // the cut going on (the button down): where the pointer was last (canvas coordinates), and whether Ctrl+Z has its step
    const cut = useRef<{ last: XYPosition; recorded: boolean } | null>(null);
    const actionsNow = () => ({
        arrange: arrangeFlow,
        group: addGroup,
        palette: () => togglePalette(!paletteOpen),
        fit: () => void flow?.fitView(FIT_TO_SCREEN),
        runPanel: () => onToggleRunPanel?.(),
        calls: () => onToggleCalls?.(),
        shortcuts: () => setShortcutsOpen(open => !open),
    });
    const keyActions = useRef(actionsNow());
    useEffect(() => {
        keyActions.current = actionsNow();
    });
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || shortcutsBusy(document.activeElement)) {
                return;
            }

            const key = event.key.toLowerCase();
            if (readOnly && !['f', 'b', 'd', 'k'].includes(key)) {
                return;
            }

            if (key === 'x') {
                event.preventDefault();
                setCutArmed(true);
                return;
            }

            const action = { a: 'arrange', c: 'palette', g: 'group', f: 'fit', b: 'runPanel', d: 'calls', k: 'shortcuts' }[key] as
                keyof typeof keyActions.current | undefined;
            if (action) {
                event.preventDefault();
                if (!event.repeat) {
                    keyActions.current[action]();
                }
            }
        };
        // letting go of X ends the cut too, the button still down
        const disarm = () => {
            setCutArmed(false);
            cut.current = null;
        };
        const onKeyUp = (event: KeyboardEvent) => event.key.toLowerCase() === 'x' && disarm();
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', disarm);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('blur', disarm);
        };
    }, [readOnly]);

    // ---- the cut (editor/edge-cut.ts): with X held, dragging with the primary button cuts every edge the pointer crosses;
    // releasing the button ends it. One Ctrl+Z step per drag, taken at the first edge it cuts
    const endCut = () => {
        cut.current = null;
    };
    const onCutDown = (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || !flow) {
            return;
        }

        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        cut.current = { last: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), recorded: false };
    };
    const onCutMove = (event: PointerEvent<HTMLDivElement>) => {
        const at = cut.current;
        if (!at || !flow) {
            return;
        }

        const now = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        const all = flow.getEdges();
        const crossed = new Set(
            crossedEdges(
                at.last,
                now,
                all.map(e => e.id),
                edgePoints,
            ),
        );
        if (crossed.size > 0) {
            if (!at.recorded) {
                record();
                at.recorded = true;
            }

            setEdges(current => current.filter(e => !crossed.has(e.id)));
        }

        at.last = now;
    };

    // dragging a group takes along what is entirely inside it (and not selected: those move by themselves)
    const groupDrag = useRef<{ id: string; start: XYPosition; inside: Map<string, XYPosition> } | null>(null);

    const onNodeDragStart = (_: unknown, node: FlowNode) => {
        record();
        groupDrag.current = null;
        if (node.type !== 'group') {
            return;
        }

        const width = node.measured?.width ?? node.width ?? 0;
        const height = node.measured?.height ?? node.height ?? 0;
        const inside = new Map<string, XYPosition>();
        for (const other of flow?.getNodes() ?? nodes) {
            const w = other.measured?.width ?? 0;
            const h = other.measured?.height ?? 0;
            const within =
                other.position.x >= node.position.x &&
                other.position.y >= node.position.y &&
                other.position.x + w <= node.position.x + width &&
                other.position.y + h <= node.position.y + height;
            if (other.id !== node.id && !other.selected && within) {
                inside.set(other.id, other.position);
            }
        }

        groupDrag.current = { id: node.id, start: node.position, inside };
    };

    const onNodeDrag = (_: unknown, node: FlowNode) => {
        const drag = groupDrag.current;
        if (!drag || drag.id !== node.id || drag.inside.size === 0) {
            return;
        }

        const dx = node.position.x - drag.start.x;
        const dy = node.position.y - drag.start.y;
        setNodes(current =>
            current.map(n => {
                const start = drag.inside.get(n.id);
                return start ? { ...n, position: { x: start.x + dx, y: start.y + dy } } : n;
            }),
        );
    };

    // ---- the components' windows (editor/floating-window.tsx): a double click opens one; several stay open, the last
    // one in front
    // minimized: hidden but kept (its size and unsaved edits), a chip in the bottom-left tray, in the order minimized
    type OpenWindow = { id: string; position: WindowPosition; size?: WindowSize; minimized?: number; changed?: boolean };
    const [windows, setWindows] = useState<OpenWindow[]>([]);
    // each window comes back where it was and with its size (this browser tab, per flow and component)
    const resources = useLoadProjectResources(projectId);
    const openWindow = (id: string) => {
        // the component goes out of the selection: the window is where the work goes on (its Ctrl+C copies its text)
        setNodes(current => (current.some(n => n.selected) ? current.map(n => (n.selected ? { ...n, selected: false } : n)) : current));
        openWindowOnly(id);
    };
    const openWindowOnly = (id: string) =>
        setWindows(current => {
            const open = current.find(w => w.id === id);
            if (open) {
                // already open: to the front, restored when minimized
                return [...current.filter(w => w.id !== id), { ...open, minimized: undefined }];
            }

            const remembered = readWindow(flowId, id);
            const n = current.length % 8;
            const type = nodes.filter(isComponent).find(node => node.id === id)?.data.type;
            // a code editor or a table needs room: those windows open wider (a size the user left wins)
            const wide = componentSettings(String(type)).some(setting => setting.kind === 'code' || setting.kind === 'grid');
            return [
                ...current,
                {
                    id,
                    position: remembered.position ?? { x: 320 + n * 28, y: 24 + n * 28 },
                    size: remembered.size ?? (wide ? WIDE_WINDOW : undefined),
                },
            ];
        });
    const closeWindow = (id: string) => setWindows(current => current.filter(w => w.id !== id));
    const focusWindow = (id: string) =>
        setWindows(current =>
            current.at(-1)?.id === id ? current : [...current.filter(w => w.id !== id), current.find(w => w.id === id)!],
        );
    const updateWindow = (id: string, changes: Partial<OpenWindow>) =>
        setWindows(current => current.map(w => (w.id === id ? { ...w, ...changes } : w)));
    const minimizeWindow = (id: string) => updateWindow(id, { minimized: Date.now() });
    // closing a minimized window: right away; with unsaved changes it comes back first and asks (Discard changes?)
    const closeMinimized = (w: OpenWindow) => {
        if (!w.changed) {
            closeWindow(w.id);
            return;
        }

        openWindow(w.id);
        closers.current.get(w.id)?.();
    };
    // only when it changes: the window reports it on every render
    const markChanged = (id: string, changed: boolean) =>
        setWindows(current =>
            current.some(w => w.id === id && !!w.changed !== changed) ? current.map(w => (w.id === id ? { ...w, changed } : w)) : current,
        );
    // Save in a window: all its changes at once, one Ctrl+Z step, and the window closes
    const saveComponent = (id: string, draft: ComponentDraft) => {
        record();
        const node = nodes.find(n => n.id === id);
        const type = node && isComponent(node) ? node.data.type : undefined;
        // a config that leaves no choice about On error (Fire and forget: Throw) takes it, and its error port goes with its edges
        const fixed = type ? fixedOnError(type, draft.config) : undefined;
        const changes: Partial<ComponentData> = {
            config: fixed ? { ...draft.config, onError: fixed } : draft.config,
            label: draft.label?.trim() || undefined,
            outputKey: draft.outputKey?.trim() || undefined,
            override: draft.override || undefined,
            notes: draft.notes || undefined,
        };
        const updated = nodes.map(n => (n.id === id && isComponent(n) ? { ...n, data: { ...n.data, ...changes } } : n));
        setNodes(updated);
        // a port the new config no longer has takes its edges along (Undo brings both back)
        setEdges(current => edgesWithPorts(updated, current));
        closeWindow(id);
    };
    // Save in a Loop's window (editor/loop-window.tsx): one Ctrl+Z step; leaving Divert takes the error port's edge
    const saveLoop = (id: string, data: LoopData) => {
        record();
        // the window does not show the pin: it stays as it is
        setNodes(current =>
            current.map(n => (n.id === id && n.type === LOOP_TYPE ? { ...n, data: { ...data, pinned: n.data.pinned } } : n)),
        );
        if (data.onError !== 'divert') {
            setEdges(current => current.filter(e => !(e.source === loopEndId(id) && e.sourceHandle === LOOP_PORTS.error)));
        }
        closeWindow(id);
    };
    const pendingBridges = useRef<ReturnType<typeof bridges>>([]);
    const removeComponent = (id: string) => {
        record();
        // a Loop goes with both its cards
        const going = nodes.some(n => n.id === id && n.type === LOOP_TYPE) ? new Set([id, loopEndId(id)]) : new Set([id]);
        setNodes(current => current.filter(n => !going.has(n.id)));
        // C1 → C2 → C3 without C2: C1 → C3 (editor/bridge-delete.ts)
        setEdges(current => edgesAfterDelete(going, loopAsOne(going, current), typeOfNode));
        closeWindow(id);
    };
    // each window's own way to close (it asks first when it has unsaved changes), used by its X and Esc
    const closers = useRef(new Map<string, () => void>());

    // a deleted component (Delete, Ctrl+Z...) has no window to show
    const shownWindows = windows.filter(w => nodes.some(n => n.id === w.id));
    // the front window is the last one not minimized
    const frontWindow = shownWindows.filter(w => !w.minimized).at(-1)?.id;
    const dock = shownWindows.filter(w => w.minimized).sort((a, b) => (a.minimized ?? 0) - (b.minimized ?? 0));
    // $PARAMETERS in a TypeScript component's code: the Start's parameters (only the text changes when they do)
    // an expression field's suggestions at a component: what reached it in the runs so far, then the system variables
    const parameters = startParameters(nodes.filter(isComponent).map(n => n.data));
    const globals = (nodeId?: string) => {
        const samples = nodeId ? inputSamples?.[nodeId] : undefined;
        return scriptGlobals(parameters, samples?.length ? dataTypeFromSamples(samples) : undefined);
    };
    // the Loop end card's ports are its Loop's, as the runs know them
    const portEdges = edges.map(e => fileEdgeOf(portEdge(e)));
    const system = systemVariables(parameters, resources.variables, resources.secrets);
    const loopVariableAt = (nodeId: string) =>
        nodes.some(n => n.id === nodeId && n.type === LOOP_TYPE) || !!loopRegions(nodes, edges).get(nodeId);
    const expressionVariables = {
        of: (nodeId: string, port?: string) => [
            ...inputVariables(known ?? {}, portEdges, nodeId, port).variables,
            // $_loopIndex in the components inside a Loop and in its stop condition (editor/loop.ts)
            ...(loopVariableAt(nodeId) ? [{ path: LOOP_INDEX, type: 'number', example: '0' }] : []),
            ...system,
        ],
        seen: (nodeId: string, port?: string) => inputVariables(known ?? {}, portEdges, nodeId, port).seen,
    };

    return (
        <RunMarksContext.Provider value={marks}>
            <RunFromContext.Provider value={onRunFrom}>
                <ProjectResourcesContext.Provider value={resources}>
                    <ScriptGlobalsContext.Provider value={globals}>
                        <ExpressionVariablesContext.Provider value={expressionVariables}>
                            <HistoryContext.Provider value={history}>
                                {/* read-only: the components take no clicks (their menus, ports and fields), the canvas still pans and zooms */}
                                {/* while the flow opens: the grid and the tools, not the flow (nor its minimap), under the veil */}
                                <div
                                    className={cn('relative h-full w-full', readOnly && '[&_.react-flow__node]:pointer-events-none')}
                                    aria-busy={veiled}
                                    data-flow-loading={veiled ? '' : undefined}
                                >
                                    <ReactFlow
                                        {...editing(readOnly)}
                                        nodes={shownNodes}
                                        edges={opening ? NO_EDGES : shownEdges}
                                        nodeTypes={NODE_TYPES}
                                        onNodesChange={onNodesChange}
                                        onEdgesChange={onEdgesChange}
                                        onConnect={onConnect}
                                        isValidConnection={isValidConnection}
                                        onInit={setFlow}
                                        onDragOver={onDragOver}
                                        onDrop={onDrop}
                                        onMouseMove={event => (pointer.current = { x: event.clientX, y: event.clientY })}
                                        onMouseLeave={() => (pointer.current = null)}
                                        onDragLeave={event =>
                                            !event.currentTarget.contains(event.relatedTarget as Node | null) && setSpliceEdge(null)
                                        }
                                        onNodeDragStart={onNodeDragStart}
                                        onSelectionDragStart={record}
                                        onBeforeDelete={async ({ nodes: selectedGoing, edges: goingEdges }) => {
                                            record();
                                            // a Loop goes with both its cards, whichever was selected
                                            const allNodes = flow?.getNodes() ?? nodes;
                                            const pairs = new Set(
                                                selectedGoing
                                                    .filter(n => n.type === LOOP_TYPE || n.type === LOOP_END_TYPE)
                                                    .flatMap(n => [loopOfEnd(n.id), loopEndId(loopOfEnd(n.id))]),
                                            );
                                            const going = [
                                                ...selectedGoing,
                                                ...allNodes.filter(n => pairs.has(n.id) && !selectedGoing.some(g => g.id === n.id)),
                                            ];
                                            // C1 → C2 → C3 without C2: C1 → C3, added once the delete is done (editor/bridge-delete.ts)
                                            const all = flow?.getEdges() ?? edges;
                                            const ids = new Set(going.map(n => n.id));
                                            const removed = new Set(goingEdges.map(e => e.id));
                                            const kept = all.filter(e => !removed.has(e.id) && !ids.has(e.source) && !ids.has(e.target));
                                            pendingBridges.current = bridges(ids, loopAsOne(ids, all), kept, typeOfNode);
                                            const goingEdgeList = all.filter(
                                                e => removed.has(e.id) || ids.has(e.source) || ids.has(e.target),
                                            );
                                            return { nodes: going, edges: goingEdgeList };
                                        }}
                                        onDelete={() => {
                                            const added = pendingBridges.current;
                                            pendingBridges.current = [];
                                            if (added.length > 0) {
                                                setEdges(current => added.reduce((next, bridge) => addEdge(bridge, next), current));
                                            }
                                        }}
                                        onNodeDrag={onNodeDrag}
                                        // opens with the whole flow on screen (Start and End at first), never zoomed past 100%, clear of the palette
                                        fitView
                                        fitViewOptions={FIT_VIEW}
                                        // remembered once the flow is shown: not the view fitted around the default Start and End while it loads
                                        onMoveEnd={(_, view) => !veiled && rememberViewport(flowId, view)}
                                        snapToGrid
                                        snapGrid={[DOT_GAP, DOT_GAP]}
                                        selectionMode={SelectionMode.Partial}
                                        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
                                        elevateNodesOnSelect={false}
                                        panOnDrag={[1, 2]}
                                        panOnScroll
                                        zoomActivationKeyCode={['Meta', 'Control']}
                                        zoomOnDoubleClick={false}
                                        onNodeDoubleClick={(_, node) =>
                                            !readOnly &&
                                            (node.type === LOOP_TYPE ||
                                                node.type === LOOP_END_TYPE ||
                                                (isComponent(node) && (!isFixedType(node.data.type) || node.data.type === START))) &&
                                            openWindow(loopOfEnd(node.id))
                                        }
                                        minZoom={0.2}
                                        proOptions={{ hideAttribution: true }}
                                    >
                                        <Background variant={BackgroundVariant.Dots} gap={DOT_GAP} size={DOT_SIZE} color="var(--grid)" />
                                        {!readOnly && <ComponentPalette open={paletteOpen} onToggle={() => togglePalette(!paletteOpen)} />}
                                        {/* one strip from the components' rail (pushed along by their drawer when it is open) to the right edge:
                                            Calls, then editing on the left, running on the right; when both do not fit, the running group goes
                                            whole to the line below. A read-only flow has no drawer and only Calls */}
                                        <Panel
                                            position="top-left"
                                            className="pointer-events-none flex flex-wrap items-start gap-2"
                                            style={{
                                                margin: 12,
                                                marginLeft: palette + 12,
                                                width: `calc(100% - ${palette + 24}px)`,
                                                // along with the drawer
                                                transition: 'margin-left 200ms, width 200ms',
                                            }}
                                        >
                                            <div className="nopan nowheel nodrag pointer-events-auto flex flex-wrap gap-2">
                                                {toolsBefore}
                                                {!readOnly && (
                                                    <>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            className="bg-card shadow-md"
                                                            onClick={addGroup}
                                                            title="Group: a colored rectangle behind the components (G)"
                                                        >
                                                            <SquareDashed /> Group
                                                        </Button>
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            className="bg-card shadow-md"
                                                            onClick={arrangeFlow}
                                                            title="Arrange from left to right, the cards glued (A)"
                                                        >
                                                            <Network className="-rotate-90" /> Arrange
                                                        </Button>
                                                        <div className="flex rounded-md bg-card shadow-md">
                                                            <Button
                                                                variant="outline"
                                                                size="icon-sm"
                                                                className="rounded-r-none"
                                                                disabled={!steps.undo}
                                                                onClick={undo}
                                                                title="Undo (Ctrl+Z)"
                                                                aria-label="Undo"
                                                            >
                                                                <Undo2 />
                                                            </Button>
                                                            <Button
                                                                variant="outline"
                                                                size="icon-sm"
                                                                className="-ml-px rounded-l-none"
                                                                disabled={!steps.redo}
                                                                onClick={redo}
                                                                title="Redo (Ctrl+Y)"
                                                                aria-label="Redo"
                                                            >
                                                                <Redo2 />
                                                            </Button>
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                            {!readOnly && (tools || toolsAfter) && (
                                                // the worker tag, Deploy, Schedules, Webhooks
                                                <div className="nopan nowheel nodrag pointer-events-auto ml-auto flex flex-wrap justify-end gap-2">
                                                    {tools}
                                                    {toolsAfter}
                                                </div>
                                            )}
                                        </Panel>
                                        <ZoomControls />
                                        <ShortcutsDialog open={shortcutsOpen} readOnly={readOnly} onClose={() => setShortcutsOpen(false)} />
                                        {/* the whole flow in small, bottom right: drag on it to pan, scroll on it to zoom */}
                                        <MiniMap<FlowNode>
                                            pannable
                                            zoomable
                                            nodeColor={minimapColor}
                                            nodeBorderRadius={6}
                                            bgColor="var(--card)"
                                            maskColor="color-mix(in oklch, var(--canvas) 70%, transparent)"
                                            className="overflow-hidden rounded-lg border shadow-md"
                                            ariaLabel="Minimap"
                                        />
                                    </ReactFlow>
                                    {cutArmed && (
                                        // X held: the cut's layer over the canvas (under the windows), with the scissors as the pointer
                                        <div
                                            data-cut
                                            aria-label="Cut the edges: drag across them"
                                            className="absolute inset-0"
                                            style={{ cursor: SCISSORS_CURSOR }}
                                            onPointerDown={onCutDown}
                                            onPointerMove={onCutMove}
                                            onPointerUp={endCut}
                                            onPointerCancel={endCut}
                                        />
                                    )}
                                    {veiled && (
                                        // the flow is opening: the canvas waits under a veil
                                        <div
                                            role="status"
                                            aria-label="Opening the flow"
                                            className="absolute inset-0 z-20 flex items-center justify-center bg-background/60 backdrop-blur-[1px]"
                                        >
                                            <span className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground shadow-md">
                                                <LoaderCircle className="size-4 animate-spin" aria-hidden /> Opening…
                                            </span>
                                        </div>
                                    )}
                                    {/* the windows' layer: over the canvas, letting the pointer through where there is no window */}
                                    <div data-windows className="pointer-events-none absolute inset-0 overflow-hidden">
                                        {shownWindows.map((w, i) => {
                                            const node = nodes.find(n => n.id === w.id);
                                            const info = windowInfo(node);
                                            if (!node || !info) {
                                                return null;
                                            }

                                            const color = CATEGORIES[info.category].color;
                                            return (
                                                <FloatingWindow
                                                    key={w.id}
                                                    label={`Configuration of ${labelOf(node) || info.label}`}
                                                    title={labelOf(node) || info.label}
                                                    subtitle={info.label}
                                                    icon={
                                                        <span
                                                            className="flex size-9 shrink-0 items-center justify-center rounded-md"
                                                            style={{
                                                                color,
                                                                backgroundColor: `color-mix(in oklch, ${color} 15%, transparent)`,
                                                            }}
                                                        >
                                                            <info.icon className="size-5" aria-hidden />
                                                        </span>
                                                    }
                                                    position={w.position}
                                                    initialSize={w.size}
                                                    z={i + 1}
                                                    active={w.id === frontWindow}
                                                    minimized={w.minimized !== undefined}
                                                    onMove={position => {
                                                        updateWindow(w.id, { position });
                                                        rememberWindow(flowId, w.id, { position });
                                                    }}
                                                    onResize={size => {
                                                        updateWindow(w.id, { size });
                                                        rememberWindow(flowId, w.id, { size });
                                                    }}
                                                    onFocus={() => focusWindow(w.id)}
                                                    onMinimize={() => minimizeWindow(w.id)}
                                                    onClose={() => (closers.current.get(w.id) ?? (() => closeWindow(w.id)))()}
                                                >
                                                    {node.type === LOOP_TYPE ? (
                                                        // the Loop's own window (editor/loop-window.tsx)
                                                        <LoopWindow
                                                            id={w.id}
                                                            data={node.data}
                                                            onSave={data => saveLoop(w.id, data)}
                                                            onCancel={() => closeWindow(w.id)}
                                                            onRemove={() => removeComponent(w.id)}
                                                            registerClose={close => {
                                                                closers.current.set(w.id, close);
                                                            }}
                                                            onChanged={changed => markChanged(w.id, changed)}
                                                        />
                                                    ) : (
                                                        isComponent(node) && (
                                                            <ComponentWindow
                                                                id={w.id}
                                                                data={node.data}
                                                                onSave={draft => saveComponent(w.id, draft)}
                                                                onCancel={() => closeWindow(w.id)}
                                                                onRemove={() => removeComponent(w.id)}
                                                                registerClose={close => {
                                                                    closers.current.set(w.id, close);
                                                                }}
                                                                onChanged={changed => markChanged(w.id, changed)}
                                                            />
                                                        )
                                                    )}
                                                </FloatingWindow>
                                            );
                                        })}
                                        {/* the minimized windows: chips from left to right in the bottom-left corner; a click restores one */}
                                        {dock.length > 0 && (
                                            <div
                                                aria-label="Minimized windows"
                                                className="pointer-events-auto absolute bottom-3 left-3 flex max-w-[calc(100%-24px)] gap-2 overflow-x-auto"
                                            >
                                                {dock.map(w => {
                                                    const node = nodes.find(n => n.id === w.id);
                                                    const info = windowInfo(node);
                                                    if (!node || !info) {
                                                        return null;
                                                    }

                                                    const name = labelOf(node) || info.label;
                                                    return (
                                                        <div
                                                            key={w.id}
                                                            className="flex h-8 max-w-52 shrink-0 items-center rounded-lg border bg-card text-xs font-medium shadow-md"
                                                        >
                                                            {/* the X first: closing the first chip brings the next one under the pointer, so several close fast */}
                                                            <button
                                                                type="button"
                                                                aria-label={`Close ${name}`}
                                                                title="Close"
                                                                onClick={() => closeMinimized(w)}
                                                                className="flex h-full shrink-0 items-center rounded-l-lg px-1.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                                                            >
                                                                <X className="size-3.5" aria-hidden />
                                                            </button>
                                                            <button
                                                                type="button"
                                                                title={w.changed ? `${name} (unsaved changes)` : name}
                                                                aria-label={`Restore ${name}`}
                                                                onClick={() => openWindow(w.id)}
                                                                className="flex h-full min-w-0 items-center gap-2 rounded-r-lg border-l pr-2.5 pl-2 transition-colors hover:bg-accent"
                                                            >
                                                                <info.icon
                                                                    className="size-3.5 shrink-0"
                                                                    style={{ color: CATEGORIES[info.category].color }}
                                                                    aria-hidden
                                                                />
                                                                <span className="truncate">{name}</span>
                                                                {w.changed && (
                                                                    <span
                                                                        className="size-1.5 shrink-0 rounded-full bg-amber-500"
                                                                        aria-label="unsaved changes"
                                                                    />
                                                                )}
                                                            </button>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </HistoryContext.Provider>
                        </ExpressionVariablesContext.Provider>
                    </ScriptGlobalsContext.Provider>
                </ProjectResourcesContext.Provider>
            </RunFromContext.Provider>
        </RunMarksContext.Provider>
    );
}
