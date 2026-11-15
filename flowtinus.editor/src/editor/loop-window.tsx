import { useEffect, useState } from 'react';
import { Trash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ExpressionBox } from './expression-box';
import { MAX_ITERATIONS, PARALLEL_LOOPS, TEST_RUN_MAX_ITERATIONS, type CheckTiming } from '@flowtinus/core';
import type { LoopData } from './loop';

type Tab = 'configuration' | 'notes';

type Props = {
    id: string;
    data: LoopData;
    onSave: (data: LoopData) => void;
    onCancel: () => void;
    onRemove: () => void;
    registerClose: (close: () => void) => void;
    onChanged?: (changed: boolean) => void;
};

/**
 * The body of a Loop's window (loop.ts), as a component's (component-window.tsx): Configuration (its name, the most
 * iterations, the stop condition and when it is checked, the parallel switch; On error is in its bar, as a component's)
 * and Notes. Save applies it all at once, Cancel drops it, X or Esc ask first when something changed, Remove deletes
 * the Loop (what is inside it stays on the canvas).
 */
export function LoopWindow({ id, data, onSave, onCancel, onRemove, registerClose, onChanged }: Props) {
    const [tab, setTab] = useState<Tab>('configuration');
    const [draft, setDraft] = useState<LoopData>(data);
    const changed =
        (draft.label ?? '') !== (data.label ?? '') ||
        draft.maxIterations !== data.maxIterations ||
        (draft.stopCondition ?? '') !== (data.stopCondition ?? '') ||
        draft.checkTiming !== data.checkTiming ||
        Boolean(draft.parallel) !== Boolean(data.parallel) ||
        (draft.notes ?? '') !== (data.notes ?? '');
    useEffect(() => {
        onChanged?.(changed);
    }, [changed, onChanged]);
    const set = (changes: Partial<LoopData>) => setDraft(current => ({ ...current, ...changes }));

    const [confirming, setConfirming] = useState(false);
    const requestClose = () => (changed ? setConfirming(true) : onCancel());
    useEffect(() => {
        registerClose(requestClose);
    });

    return (
        <>
            <div role="tablist" className="flex shrink-0 gap-1 border-b px-3">
                {(
                    [
                        ['configuration', 'Configuration'],
                        ['notes', 'Notes'],
                    ] as const
                ).map(([value, label]) => (
                    <button
                        key={value}
                        type="button"
                        role="tab"
                        aria-selected={tab === value}
                        onClick={() => setTab(value)}
                        className={cn(
                            '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
                            tab === value
                                ? 'border-primary font-medium text-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground',
                        )}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {tab === 'configuration' ? (
                <div role="tabpanel" className="flex min-h-0 flex-1 flex-col gap-5 overflow-x-hidden overflow-y-auto p-4 [&>*]:shrink-0">
                    <div className="grid gap-2">
                        <Label htmlFor={`${id}-label`}>Name</Label>
                        <Input
                            id={`${id}-label`}
                            value={draft.label ?? ''}
                            placeholder="Loop"
                            onChange={event => set({ label: event.target.value })}
                        />
                    </div>

                    <div className="grid gap-2 border-t pt-4">
                        <Label htmlFor={`${id}-max`}>Max iterations</Label>
                        <Input
                            id={`${id}-max`}
                            type="number"
                            min={1}
                            max={MAX_ITERATIONS}
                            value={draft.maxIterations}
                            className="w-40 font-mono"
                            onChange={event =>
                                set({ maxIterations: Math.min(MAX_ITERATIONS, Math.max(1, Math.round(Number(event.target.value)) || 1)) })
                            }
                        />
                        <p className="text-xs text-muted-foreground">
                            A safety limit: the loop ends after this many iterations, with a warning ({TEST_RUN_MAX_ITERATIONS} at most in a
                            test run).
                        </p>
                    </div>

                    <div className="grid gap-2 border-t pt-4">
                        <Label htmlFor={`${id}-stop`}>Stop condition</Label>
                        <ExpressionBox
                            id={`${id}-stop`}
                            nodeId={id}
                            value={draft.stopCondition ?? ''}
                            placeholder="e.g. $_loopIndex >= 10 || !$hasMore"
                            onChange={stopCondition => set({ stopCondition })}
                        />
                        <p className="text-xs text-muted-foreground">
                            An expression on the loop state ($DATA and its keys) and <code className="font-mono">$_loopIndex</code> (0 in
                            the first iteration): true ends the loop. Empty: only Max iterations ends it.
                        </p>
                        <RadioGroup
                            aria-label="Check the stop condition"
                            value={draft.checkTiming}
                            onValueChange={value => set({ checkTiming: value as CheckTiming })}
                            className="mt-1 gap-2"
                        >
                            {(
                                [
                                    ['before', 'Before each iteration', 'while: none may run'],
                                    ['after', 'After each iteration', 'do-while: the first always runs'],
                                ] as const
                            ).map(([value, label, hint]) => (
                                <div key={value} className="flex items-center gap-2 text-sm">
                                    <RadioGroupItem value={value} id={`${id}-check-${value}`} />
                                    <Label htmlFor={`${id}-check-${value}`} className="font-normal">
                                        {label} <span className="text-xs text-muted-foreground">({hint})</span>
                                    </Label>
                                </div>
                            ))}
                        </RadioGroup>
                    </div>

                    <div className="grid gap-2 border-t pt-4">
                        <div className="flex items-center gap-2">
                            <Switch
                                id={`${id}-parallel`}
                                checked={draft.parallel ?? false}
                                onCheckedChange={parallel => set({ parallel })}
                            />
                            <Label htmlFor={`${id}-parallel`}>Parallel</Label>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            Runs the loops of several input envelopes at the same time, up to {PARALLEL_LOOPS} at once (the rest wait), each
                            with its own loop state and <code className="font-mono">$_loopIndex</code>; what reaches Iteration end goes out
                            interleaved, as it arrives. Off: one loop after another, in arrival order.
                        </p>
                    </div>
                </div>
            ) : (
                <div role="tabpanel" className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-4 [&>*]:shrink-0">
                    <div className="grid gap-2">
                        <Label htmlFor={`${id}-notes`}>Notes</Label>
                        <Textarea
                            id={`${id}-notes`}
                            value={draft.notes ?? ''}
                            className="min-h-24"
                            onChange={event => set({ notes: event.target.value })}
                        />
                    </div>
                    <p className="border-t pt-4 text-sm leading-relaxed text-muted-foreground">
                        Runs the components inside it again and again; each envelope that comes in runs a loop of its own. Each iteration
                        starts at Iteration start with the loop state; what reaches Iteration end goes out of the Loop as it arrives.
                    </p>
                </div>
            )}

            {confirming ? (
                <footer
                    role="alertdialog"
                    aria-label="Discard changes?"
                    className="flex shrink-0 items-center gap-2 border-t bg-muted/50 px-4 py-3"
                >
                    <span className="text-sm font-medium">Discard changes?</span>
                    <Button variant="outline" size="sm" className="ml-auto" autoFocus onClick={() => setConfirming(false)}>
                        Keep editing
                    </Button>
                    <Button variant="destructive" size="sm" onClick={onCancel}>
                        Discard
                    </Button>
                </footer>
            ) : (
                <footer className="flex shrink-0 items-center gap-2 border-t px-4 py-3">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={onRemove}
                    >
                        <Trash /> Remove
                    </Button>
                    <Button variant="outline" size="sm" className="ml-auto" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        disabled={!changed}
                        onClick={() =>
                            onSave({
                                ...draft,
                                label: draft.label?.trim() || undefined,
                                stopCondition: draft.stopCondition?.trim() || undefined,
                                parallel: draft.parallel || undefined,
                                notes: draft.notes || undefined,
                            })
                        }
                    >
                        Save
                    </Button>
                </footer>
            )}
        </>
    );
}
