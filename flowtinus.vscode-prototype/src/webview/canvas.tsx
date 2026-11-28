// PROTOTYPE (#86): throwaway. The canvas in the webview: it only draws what the extension sends and posts back gestures;
// the text document stays the one truth (undo, dirty, save are VS Code's).
import { Background, Controls, Handle, Position, ReactFlow, applyNodeChanges, type Connection, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

type CardData = { type: string; typeLabel: string; label?: string; refs: string[]; inputs: number; outputs: string[] };
type FlowNode = { id: string; position: { x: number; y: number } } & CardData;
type FlowEdge = { source: string; sourcePort: string; target: string; targetPort: string };
type State = { flow: { nodes: FlowNode[]; edges: FlowEdge[] } | null; errors: string[] };

const handleTop = (i: number, count: number) => `${((i + 1) / (count + 1)) * 100}%`;

function Card({ id, data, selected }: NodeProps<Node<CardData>>) {
    return (
        <div
            className={`card ${selected ? 'selected' : ''} type-${data.type}`}
            onDoubleClick={() => vscode.postMessage({ type: 'rename', id })}
        >
            {Array.from({ length: data.inputs }, (_, i) => (
                <Handle key={`in-${i}`} id={`in-${i}`} type="target" position={Position.Left} style={{ top: handleTop(i, data.inputs) }} />
            ))}
            <div className="title">{data.label || data.typeLabel}</div>
            <div className="sub">{data.type}</div>
            {data.refs.map(r => (
                <div key={r} className={`ref ${r.startsWith('unknown') ? 'bad' : ''}`}>
                    {r}
                </div>
            ))}
            {data.outputs.map((port, i) => (
                <Handle
                    key={port}
                    id={port}
                    type="source"
                    position={Position.Right}
                    className={port === 'error' ? 'error-port' : ''}
                    style={{ top: handleTop(i, data.outputs.length) }}
                />
            ))}
        </div>
    );
}

const nodeTypes = { card: Card };

const toNodes = (flow: NonNullable<State['flow']>): Node<CardData>[] =>
    flow.nodes.map(({ id, position, ...data }) => ({ id, position, data, type: 'card' }));

const toEdges = (flow: NonNullable<State['flow']>): Edge[] =>
    flow.edges.map(e => ({
        id: `${e.source}:${e.sourcePort}->${e.target}:${e.targetPort}`,
        source: e.source,
        sourceHandle: e.sourcePort,
        target: e.target,
        targetHandle: e.targetPort,
        className: e.sourcePort === 'error' ? 'error-edge' : '',
    }));

function App() {
    const [state, setState] = useState<State>({ flow: null, errors: [] });
    const [nodes, setNodes] = useState<Node<CardData>[]>([]);
    const [edges, setEdges] = useState<Edge[]>([]);
    const [renders, setRenders] = useState(0);

    useEffect(() => {
        const listener = (e: MessageEvent) => {
            if (e.data?.type !== 'state') {
                return;
            }
            setState(e.data);
            setRenders(r => r + 1);
            if (e.data.flow) {
                // keep the selection across a re-render from the text
                setNodes(old => toNodes(e.data.flow).map(n => ({ ...n, selected: old.find(o => o.id === n.id)?.selected })));
                setEdges(toEdges(e.data.flow));
            }
        };
        window.addEventListener('message', listener);
        vscode.postMessage({ type: 'ready' });
        return () => window.removeEventListener('message', listener);
    }, []);

    const onNodesChange = (changes: NodeChange<Node<CardData>>[]) => setNodes(ns => applyNodeChanges(changes, ns));
    const onConnect = (c: Connection) =>
        vscode.postMessage({
            type: 'connect',
            edge: { source: c.source, sourcePort: c.sourceHandle, target: c.target, targetPort: c.targetHandle },
        });

    return (
        <div className="shell">
            <div className="bar">
                <span className="proto">PROTOTYPE</span>
                <button onClick={() => vscode.postMessage({ type: 'add', x: 200, y: 200 })}>+ Add card</button>
                <button onClick={() => vscode.postMessage({ type: 'openText' })}>Text beside</button>
                <span className="hint">drag · connect · Delete · double-click a card to rename · Ctrl+Z is the file's undo</span>
                <span className="renders">renders from text: {renders}</span>
            </div>
            {state.errors.length > 0 && (
                <div className="errors">
                    {state.flow ? 'The tree validation says:' : 'The file does not read as a flow; fix the text (read only until then):'}
                    <ul>
                        {state.errors.map(e => (
                            <li key={e}>{e}</li>
                        ))}
                    </ul>
                </div>
            )}
            {state.flow && (
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    onNodesChange={onNodesChange}
                    onNodeDragStop={(_e, _node, dragged) =>
                        vscode.postMessage({ type: 'move', moves: dragged.map(n => ({ id: n.id, x: n.position.x, y: n.position.y })) })
                    }
                    onConnect={onConnect}
                    onDelete={({ nodes: ns, edges: es }) =>
                        vscode.postMessage({
                            type: 'delete',
                            nodes: ns.map(n => n.id),
                            edges: es.map(e => ({
                                source: e.source,
                                sourcePort: e.sourceHandle,
                                target: e.target,
                                targetPort: e.targetHandle,
                            })),
                        })
                    }
                    deleteKeyCode={['Delete', 'Backspace']}
                    colorMode="system"
                    fitView
                >
                    <Background />
                    <Controls />
                </ReactFlow>
            )}
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<App />);
