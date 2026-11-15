import { Channel } from '../channel';
import { FlowExecution } from '#engine/flow-execution';
import { keptSubRun } from '#engine/invoke-flow';
import type { ComponentContext } from '#types/component-context.type';
import type { Envelope } from '#types/envelope.type';
import type { ExecutableNode } from '#types/executable-node.type';
import type { IterationOf } from '#types/component-run.type';
import type { LoopControl } from '#types/loop-control.type';

/**
 * One iteration of a Loop (ADR 0002): its loop region as an inner flow built from scratch (new channels, new component
 * runs), from Iteration start with a copy of the loop state, so barriers (Aggregate, Sort, Wait) close per iteration.
 * What reaches Iteration end comes out as it arrives; its result says whether an envelope reached a Break, how many
 * reached a Continue with and the first of them (the next loop state), and whether a Next ended it right away (what was
 * still running in it stops, as on Stop, but the iteration does not fail). It runs in the run's mode, with its parameters,
 * secrets and pins; the run's Stop and timeout cancel it along with the run.
 */
export function runIteration(
    execution: FlowExecution,
    node: ExecutableNode,
    state: Envelope,
    { envelope, index }: IterationOf,
): ReturnType<ComponentContext['runIteration']> {
    const { options, parameters, control } = execution;
    const kept = keptSubRun(execution, node, { id: crypto.randomUUID(), flow: node.label, iteration: { envelope, index } });
    const iterationControl = new AbortController();
    const cancel = () => iterationControl.abort();
    // the run's Stop and timeout cancel it too, also when they came first (a parallel loop still going)
    const signal = AbortSignal.any([control.signal, iterationControl.signal]);
    const queue = new Channel<Envelope>();
    let broke = false;
    let continues = 0;
    let nextState: Envelope | undefined;
    let cutShort = false;
    const reach = (kind: LoopControl, doc: Envelope) => {
        if (kind === 'break') {
            broke = true;
            return;
        }
        if (kind === 'next') {
            if (!cutShort) {
                cutShort = true;
                inner.cutShort('Next');
            }
            return;
        }
        continues += 1;
        nextState ??= doc;
    };
    const inner = new FlowExecution(
        execution.source,
        {
            ...options,
            loop: { id: node.id, index, reach },
            input: undefined,
            runFrom: undefined,
            signal,
            // the timeout is the run's (which cancels the iteration along with it)
            timeoutMs: undefined,
            onProgress: kept?.onProgress,
            onReachEnd: doc => queue.send(doc),
        },
        parameters,
    );
    const result = inner
        .execute([structuredClone(state.DATA)])
        .then(
            record => {
                kept?.ended(record);
                return { record, broke, continues, cutShort, ...(nextState ? { nextState } : {}) };
            },
            (e: unknown) => {
                kept?.failed(e);
                throw e;
            },
        )
        .finally(() => queue.close());
    return {
        envelopes: queue,
        result,
        cancel: () => {
            cancel();
            queue.abort();
        },
    };
}
