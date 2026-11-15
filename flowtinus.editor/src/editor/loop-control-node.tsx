import { Handle, Position, useNodeConnections, useStore } from '@xyflow/react';
import { GripVertical, OctagonX, RotateCcw, SkipForward } from 'lucide-react';
import { LOOP_CONTINUE_WITH, LOOP_NEXT } from '@flowtinus/core';
import { cn } from '@/lib/utils';
import { CATEGORIES } from './catalog';
import { COMPONENT_DRAG_TYPE } from './drag';
import { LOOP_CONTROL_SIZE, strayControl } from './loop';

/*
 * Continue with, Next and Break on the canvas (loop.ts): a small component in a Loop's region, an input and no output. They are
 * dragged from the chips on the Loop card's bar (loop-node.tsx); one no Loop reaches is drawn in red.
 */

const COLOR = CATEGORIES.flow.color;

const LOOP_CONTROL_TEXT = {
    continueWith: {
        icon: RotateCcw,
        name: 'continue with',
        title: 'Continue with: the envelope that reaches it is the loop state of the next iteration',
        drag: 'Drag onto the canvas and connect it inside the loop: the envelope that reaches Continue with is the loop state of the next iteration',
    },
    next: {
        icon: SkipForward,
        name: 'next',
        title: 'Next: an envelope that reaches it ends the iteration right away; the next one starts with the same loop state',
        drag: 'Drag onto the canvas and connect it inside the loop: an envelope that reaches Next ends the iteration right away',
    },
    break: {
        icon: OctagonX,
        name: 'break',
        title: 'Break: an envelope that reaches it ends the loop after the iteration (it does not go out)',
        drag: 'Drag onto the canvas and connect it inside the loop: an envelope that reaches Break ends the loop after the iteration',
    },
};

const textOf = (type: string) =>
    type === LOOP_CONTINUE_WITH ? LOOP_CONTROL_TEXT.continueWith : type === LOOP_NEXT ? LOOP_CONTROL_TEXT.next : LOOP_CONTROL_TEXT.break;

/** a Continue or Break on the canvas, as a component node draws it (component-node.tsx) */
export function LoopControlCard(props: { id: string; type: string; selected: boolean; failed: boolean; disabled?: boolean }) {
    const { id, type, selected, failed, disabled } = props;
    const stray = useStore(state => strayControl(id, [...state.nodeLookup.values()], state.edges));
    const connected = useNodeConnections({ id, handleType: 'target' }).length > 0;
    const text = textOf(type);
    const color = stray || failed ? 'var(--destructive)' : COLOR;
    return (
        <div
            title={stray ? 'Continue with, Next and Break go inside a Loop: connect it from a component of a loop region' : text.title}
            className={cn(
                'flex items-center gap-1.5 rounded-lg border-2 bg-card px-2.5 text-xs font-semibold transition-opacity',
                disabled && 'opacity-50',
            )}
            style={{
                width: LOOP_CONTROL_SIZE.width,
                height: LOOP_CONTROL_SIZE.height,
                color,
                borderColor: `color-mix(in oklch, ${color} ${selected ? 100 : 60}%, transparent)`,
                boxShadow: selected ? `0 0 0 2px color-mix(in oklch, ${color} 25%, transparent)` : undefined,
            }}
        >
            <Handle
                id="in-0"
                type="target"
                position={Position.Left}
                className={cn('loop-port', stray && 'loop-port-error', connected && 'is-connected')}
                style={{ left: -7 }}
                aria-label="Input"
            />
            <text.icon className="size-3.5 shrink-0" aria-hidden />
            <span className={cn(disabled && 'line-through')}>{text.name}</span>
        </div>
    );
}

/** Continue with, Next or Break on the Loop card's bar: dropped on the canvas, it adds one there (flow-canvas.tsx, onDrop) */
export function LoopControlChip({ type }: { type: string }) {
    const text = textOf(type);
    return (
        <span
            draggable
            onDragStart={event => {
                event.dataTransfer.setData(COMPONENT_DRAG_TYPE, type);
                event.dataTransfer.effectAllowed = 'copy';
            }}
            title={text.drag}
            className="flex h-6 cursor-grab items-center gap-1 rounded-md border bg-card pr-1.5 pl-1 text-[11px] font-semibold shadow-xs active:cursor-grabbing"
            style={{ borderColor: `color-mix(in oklch, ${COLOR} 50%, transparent)`, color: COLOR }}
        >
            <GripVertical className="size-3 text-muted-foreground" aria-hidden />
            <text.icon className="size-3" aria-hidden />
            {text.name}
        </span>
    );
}
