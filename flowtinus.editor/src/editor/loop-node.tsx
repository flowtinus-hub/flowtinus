import { memo, useEffect, type CSSProperties } from 'react';
import { Handle, NodeToolbar, Position, useNodeConnections, useReactFlow, useStore, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { GraphHub, LoaderCircle, Pin, Play, Power, Repeat, SkipForward } from 'lucide-react';
import { pinnedOutput, runActions, useRunMark } from './run/run-marks';
import { cn } from '@/lib/utils';
import { CATEGORIES } from './catalog';
import { ActionButton, EnvelopeCount, ON_ERROR, platePath, useHover } from './component-node';
import { useHistory } from './history';
import { LOOP_PORTS, loopEndId, loopOfEnd, type LoopData, type LoopEndNode, type LoopNode } from './loop';
import { LoopControlChip } from './loop-control-node';
import { CARD_HEIGHT, CARD_WIDTH, LOOP_BREAK, LOOP_CONTINUE_WITH, LOOP_NEXT, PARALLEL_LOOPS, portTop, SIDE_GAP } from '@flowtinus/core';

/*
 * The Loop on the canvas is two cards in the Flow category's color (loop.ts). The Loop
 * card: the input's hole on the left, Iteration start's bump on the right; over it, on hover, the bar every component
 * has, with Continue with, Next and Break to drag out (loop-control-node.tsx); a double click opens its window (loop-window.tsx).
 * The Loop end card: Iteration end's hole on the left, the Loop's output bump on the right and its error port under it
 * (On error = Divert). Selecting one of them marks the other, so the pair reads as one Loop.
 */

const COLOR = CATEGORIES.flow.color;
const tint = (percent: number) => `color-mix(in oklch, ${COLOR} ${percent}%, transparent)`;
const PLATE_WIDTH = CARD_WIDTH - SIDE_GAP;

/** a card's body as a component's (platePath), tinted in the Flow color; its line strong when it or its pair is selected */
function LoopPlate(props: { errorPort: boolean; selected: boolean; paired: boolean; failed: boolean }) {
    const { errorPort, selected, paired, failed } = props;
    const width = PLATE_WIDTH + 16;
    const height = CARD_HEIGHT + (errorPort ? 16 : 0);
    const line = failed ? 'var(--destructive)' : selected ? COLOR : paired ? tint(70) : tint(45);
    return (
        <svg
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 overflow-visible"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            style={{ filter: `drop-shadow(0 1px 2px rgb(0 0 0 / ${selected ? 0.18 : 0.1}))` }}
        >
            <path
                d={platePath(1, 1, errorPort)}
                style={{
                    fill: `color-mix(in oklch, ${COLOR} 10%, var(--card))`,
                    stroke: line,
                    strokeWidth: selected || paired ? 2 : 1.5,
                    strokeDasharray: paired && !selected ? '4 3' : undefined,
                }}
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

/** a port of a Loop card, as a component's (node-port), its name next to it when it has one */
function LoopPort(props: { id: string; kind: 'source' | 'target'; connected: boolean; label?: string; title: string }) {
    const { id, kind, connected, label, title } = props;
    const input = kind === 'target';
    return (
        <>
            <Handle
                id={id}
                type={kind}
                position={input ? Position.Left : Position.Right}
                style={{ top: portTop(0) }}
                title={title}
                aria-label={title}
                className={cn('node-port', input ? 'node-port-in' : 'node-port-out', connected && 'is-connected')}
            >
                <span className="node-port-dot" aria-hidden />
            </Handle>
            {label && (
                <span
                    aria-hidden
                    style={{ top: portTop(0), color: COLOR }}
                    className={cn(
                        'pointer-events-none absolute -translate-y-[calc(100%+4px)] font-mono text-[10px] whitespace-nowrap',
                        input ? 'right-[calc(100%+6px)]' : 'left-[calc(100%+20px)]',
                    )}
                >
                    {label}
                </span>
            )}
        </>
    );
}

/** the name on a card: the Loop's icon, its name, what the card is under it */
function CardName(props: { name: string; role: string; disabled?: boolean }) {
    return (
        <div style={{ height: CARD_HEIGHT }} className="relative flex items-center text-card-foreground">
            <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
                <Repeat className="size-4 shrink-0" style={{ color: COLOR }} aria-hidden />
                <div className="min-w-0">
                    <div className={cn('line-clamp-3 text-sm leading-tight font-semibold break-words', props.disabled && 'line-through')}>
                        {props.name}
                    </div>
                    <div className="truncate font-mono text-[10px] leading-tight" style={{ color: COLOR }}>
                        {props.role}
                    </div>
                </div>
            </div>
        </div>
    );
}

function LoopNodeView({ id, data, selected }: NodeProps<LoopNode>) {
    const connections = useNodeConnections({ id });
    const connected = (port: string) => connections.some(c => (c.source === id ? c.sourceHandle : c.targetHandle) === port);
    const hover = useHover();
    const paired = useStore(state => state.nodeLookup.get(loopEndId(id))?.selected ?? false);
    const mark = useRunMark(id);
    const failed = mark?.run?.status === 'failed' || mark?.run?.status === 'with-errors';

    return (
        <>
            <LoopActions id={id} data={data} visible={hover.on} hoverProps={hover.props} />
            <div
                {...hover.props}
                style={{ '--category': COLOR, width: PLATE_WIDTH } as CSSProperties}
                className={cn('relative transition-opacity', data.disabled && 'opacity-50')}
            >
                <LoopPlate errorPort={false} selected={selected} paired={paired} failed={failed} />
                {/* what is set on it, above it where the bar appears (hidden while the bar shows); within the gap between
                stacked cards (STACK_GAP), so it does not cover the card on the row above */}
                {!hover.on && (
                    <div className="pointer-events-none absolute bottom-full left-1 mb-0.5 flex max-w-[260px] items-center gap-1.5 px-1">
                        {data.onError === 'continue' && (
                            <SkipForward role="img" aria-label="On error: continue" className="size-3.5 shrink-0 text-muted-foreground">
                                <title>On error: continue (a loop that fails sends its input envelope on; the run goes on)</title>
                            </SkipForward>
                        )}
                        {data.pinned && (
                            <Pin role="img" aria-label="Output pinned" className="size-3.5 shrink-0 rotate-45 text-muted-foreground">
                                <title>Output pinned: test runs send it instead of running the loop</title>
                            </Pin>
                        )}
                        {data.parallel && (
                            <GraphHub role="img" aria-label="Parallel" className="size-3.5 shrink-0 text-muted-foreground">
                                <title>{`Parallel: the loops of several input envelopes run at the same time, up to ${PARALLEL_LOOPS} at once`}</title>
                            </GraphHub>
                        )}
                        {data.stopCondition && (
                            <span
                                className="min-w-0 truncate rounded bg-muted px-1.5 font-mono text-[10px] leading-3 text-muted-foreground"
                                title={`Stop condition, checked ${data.checkTiming === 'after' ? 'after' : 'before'} each iteration: ${data.stopCondition}`}
                            >
                                {data.stopCondition}
                            </span>
                        )}
                    </div>
                )}
                <CardName name={data.label?.trim() || 'Loop'} role="iteration start" disabled={data.disabled} />
                {/* from outside: the envelope that starts the loop (each one its own loop) */}
                <LoopPort id={LOOP_PORTS.in} kind="target" connected={connected(LOOP_PORTS.in)} title="Input" />
                {/* to the iteration: each one starts here, with the loop state */}
                <LoopPort
                    id={LOOP_PORTS.iteration}
                    kind="source"
                    connected={connected(LOOP_PORTS.iteration)}
                    title="Iteration start: each iteration starts here, with the loop state"
                />
            </div>
        </>
    );
}

function LoopEndNodeView({ id, selected }: NodeProps<LoopEndNode>) {
    const loopId = loopOfEnd(id);
    const data = useStore(state => state.nodeLookup.get(loopId)?.data as LoopData | undefined);
    const paired = useStore(state => state.nodeLookup.get(loopId)?.selected ?? false);
    const connections = useNodeConnections({ id });
    const connected = (port: string) => connections.some(c => (c.source === id ? c.sourceHandle : c.targetHandle) === port);
    const mark = useRunMark(loopId);
    const run = mark?.run;
    const ran = run !== undefined && run.status !== 'not-run' && run.status !== 'skipped';
    const failed = run?.status === 'failed' || run?.status === 'with-errors';
    const divert = data?.onError === 'divert';
    const updateNodeInternals = useUpdateNodeInternals();
    useEffect(() => {
        updateNodeInternals(id);
    }, [id, divert, updateNodeInternals]);

    return (
        <div
            style={{ '--category': COLOR, width: PLATE_WIDTH } as CSSProperties}
            className={cn('relative transition-opacity', data?.disabled && 'opacity-50')}
        >
            <LoopPlate errorPort={divert} selected={selected} paired={paired} failed={failed} />
            <CardName name={`${data?.label?.trim() || 'Loop'} end`} role="iteration end" disabled={data?.disabled} />
            {/* from the iteration: every path of an iteration finishes here */}
            <LoopPort
                id={LOOP_PORTS.end}
                kind="target"
                connected={connected(LOOP_PORTS.end)}
                title="Iteration end: every path of an iteration finishes here; what reaches it goes out of the Loop"
            />
            {/* to outside: what reaches Iteration end, in every iteration, as it arrives */}
            <LoopPort
                id={LOOP_PORTS.out}
                kind="source"
                connected={connected(LOOP_PORTS.out)}
                title="Output: what reaches Iteration end, in every iteration, as it arrives"
            />
            {ran && (
                <EnvelopeCount
                    style={{ top: CARD_HEIGHT }}
                    count={run.outputs[LOOP_PORTS.out] ?? 0}
                    onShow={() => mark?.show(LOOP_PORTS.out)}
                    className="right-6 -translate-y-1/2"
                    tone="ok"
                />
            )}
            {divert && (
                <Handle
                    id={LOOP_PORTS.error}
                    type="source"
                    position={Position.Bottom}
                    className={cn('node-port node-port-error', connected(LOOP_PORTS.error) && 'is-connected')}
                    aria-label="Error output"
                    title="A loop that failed: its input envelope, with the error"
                >
                    <span className="node-port-dot" aria-hidden />
                </Handle>
            )}
            {divert && ran && (
                <EnvelopeCount
                    count={run.outputs[LOOP_PORTS.error] ?? 0}
                    onShow={() => mark?.show(LOOP_PORTS.error)}
                    className="top-full right-[calc(50%+22px)] mt-0.5"
                    tone="error"
                />
            )}
        </div>
    );
}

/** the bar over the Loop card, on hover, as a component's (component-node.tsx): Bypass, Run from here and On error */
function LoopActions(props: { id: string; data: LoopData; visible: boolean; hoverProps: ReturnType<typeof useHover>['props'] }) {
    const { id, data, visible, hoverProps } = props;
    const { updateNodeData, setEdges } = useReactFlow();
    const { record } = useHistory();
    // Run from here: from the input the Loop got in the last full test run, from its first iteration
    const mark = useRunMark(id);
    const running = mark?.running ?? false;
    const runFromHere = runActions(running ? undefined : mark?.full, false).runFromHere;
    const pin = runActions(running ? undefined : mark?.run, Boolean(data.pinned)).pin;
    const change = (changes: Partial<LoopData>) => {
        record();
        updateNodeData(id, changes);
    };
    return (
        <NodeToolbar isVisible={visible} position={Position.Top} align="start" offset={4}>
            <div {...hoverProps} className="flex items-center gap-0.5 rounded-md border bg-card/90 p-0.5 shadow-xs">
                <ActionButton
                    label={data.disabled ? 'Enable' : 'Bypass'}
                    pressed={data.disabled ?? false}
                    className={data.disabled ? 'text-destructive' : undefined}
                    onClick={() => change({ disabled: !data.disabled })}
                >
                    <Power />
                </ActionButton>
                {runFromHere && (
                    <ActionButton label="Run from here" disabled={running || data.disabled} onClick={() => mark?.runFrom()}>
                        {running ? <LoaderCircle className="animate-spin" /> : <Play />}
                    </ActionButton>
                )}
                {pin && (
                    <ActionButton
                        label={data.pinned ? 'Unpin output' : 'Pin output'}
                        pressed={Boolean(data.pinned)}
                        className={
                            data.pinned ? 'text-blue-600 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-400' : undefined
                        }
                        // pinned: what went out of the Loop in the last run (its output and error port), as a component's
                        onClick={() => change({ pinned: data.pinned ? undefined : pinnedOutput(mark?.run) })}
                    >
                        <Pin className={cn('transition-transform', data.pinned && 'rotate-45')} />
                    </ActionButton>
                )}
                <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
                <div role="radiogroup" aria-label="On error" className="flex items-center gap-0.5">
                    {ON_ERROR.map(option => (
                        <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={option.value === data.onError}
                            aria-label={`On error: ${option.label}`}
                            title={`On error: ${option.label}. ${LOOP_ON_ERROR[option.value]}`}
                            onClick={() => {
                                if (option.value === data.onError) {
                                    return;
                                }
                                if (option.value !== 'divert') {
                                    setEdges(edges =>
                                        edges.filter(e => !(e.source === loopEndId(id) && e.sourceHandle === LOOP_PORTS.error)),
                                    );
                                }
                                change({ onError: option.value });
                            }}
                            className={cn(
                                'flex size-5 items-center justify-center rounded transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3',
                                option.value !== data.onError && 'text-muted-foreground hover:bg-accent hover:text-foreground',
                                option.value === data.onError && option.active,
                            )}
                        >
                            <option.icon aria-hidden />
                        </button>
                    ))}
                </div>
                <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
                {/* Continue with, Next and Break come from here: dropped on the canvas, connected inside the loop */}
                <div className="nodrag nopan flex shrink-0 items-center gap-1" aria-label="Loop controls">
                    <LoopControlChip type={LOOP_CONTINUE_WITH} />
                    <LoopControlChip type={LOOP_NEXT} />
                    <LoopControlChip type={LOOP_BREAK} />
                </div>
            </div>
        </NodeToolbar>
    );
}

/** what On error does on a Loop: when an iteration fails and nothing inside handles it */
const LOOP_ON_ERROR: Record<LoopData['onError'], string> = {
    throw: 'An iteration that fails stops the run (default)',
    continue: 'An iteration that fails ends that loop: its input envelope goes out and the next one starts its loop',
    divert: 'An iteration that fails ends that loop: its input envelope, with the error, goes out through the error port',
};

export const LoopNodeMemo = memo(LoopNodeView);
export const LoopEndNodeMemo = memo(LoopEndNodeView);
