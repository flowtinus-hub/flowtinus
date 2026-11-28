import { COMPONENT_TYPE } from '#components/component-types';
import { toError } from '#errors/normalize-error';
import { mergeFields } from '#envelope/envelope-data';
import { DYNAMIC_TARGET } from '../dynamic-target';
import type { ExpressionField } from '#types/expression-field.type';
import type { ComponentLogic } from '#types/component-logic.type';
import type { ComponentContext } from '#types/component-context.type';
import type { ComponentOutput } from '#types/component-output.type';
import type { Envelope } from '#types/envelope.type';

export type InvokerParameter = ExpressionField & { name: string };

export type InvokerCall = 'wait' | 'fire-and-forget';

export type InvokerInputSource = 'data' | 'expression';

export const DEFAULT_BATCH_SIZE = 100;
export const MAX_BATCH_SIZE = 10_000;

export function flowInvokerConfig(config: Record<string, unknown>) {
    const size = Number(config.batchSize);
    const input = config.input as ExpressionField | undefined;
    const path = config.flowPath as ExpressionField | undefined;
    return {
        flowId: typeof config.flowId === 'string' ? config.flowId : '',
        flowPath:
            config.flowId === DYNAMIC_TARGET
                ? ({ value: typeof path?.value === 'string' ? path.value : '', expression: path?.expression !== false } as ExpressionField)
                : null,
        parameters: Array.isArray(config.parameters) ? (config.parameters as InvokerParameter[]) : [],
        sendEnvelope: config.sendEnvelope === true,
        inputSource: (config.inputSource === 'expression' ? 'expression' : 'data') as InvokerInputSource,
        input: { value: typeof input?.value === 'string' ? input.value : '', expression: true } as ExpressionField,
        call: (config.call === 'fire-and-forget' ? 'fire-and-forget' : 'wait') as InvokerCall,
        batchSize: Number.isInteger(size) && size >= 1 ? Math.min(size, MAX_BATCH_SIZE) : DEFAULT_BATCH_SIZE,
    };
}

/** the Start parameters of the other flow, from the envelope: an empty field is left out (it takes the default) */
function parameterValues(parameters: InvokerParameter[], doc: Envelope, ctx: ComponentContext) {
    const values: Record<string, string> = {};
    for (const p of parameters) {
        if (!p.expression && p.value === '') {
            continue;
        }
        const value = ctx.fieldValue(p, doc);
        if (value !== undefined && value !== null) {
            values[p.name] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
    }
    return values;
}

function inputOf({ sendEnvelope, inputSource, input }: ReturnType<typeof flowInvokerConfig>, ctx: ComponentContext) {
    return (doc: Envelope): unknown => (!sendEnvelope ? undefined : inputSource === 'expression' ? ctx.fieldValue(input, doc) : doc.DATA);
}

function targetOf({ flowId, flowPath }: ReturnType<typeof flowInvokerConfig>, ctx: ComponentContext) {
    return (doc: Envelope): string => {
        if (!flowPath) {
            return flowId;
        }
        const path = ctx.fieldValue(flowPath, doc);
        if (typeof path !== 'string' || !path.trim()) {
            throw new Error(`The flow path is empty (its expression gave ${JSON.stringify(path) ?? 'undefined'}).`);
        }
        return path.trim();
    };
}

export const flowInvoker: ComponentLogic = {
    type: COMPONENT_TYPE.flowInvoker,
    label: 'Flow Invoker',
    category: 'flow',
    description:
        "Runs another flow of the project for each envelope, passing its Start's parameters and, with Send an input, the envelope's DATA or an expression as its input. Wait: each envelope that reaches the other flow's End goes out as it arrives, its DATA merged into the caller's; none reaching it, nothing goes out (not a signal that it finished: see the barrier pattern). Fire and forget: the envelope goes on at once and batches of them start runs of their own. An editor's run (Run, Run for real) calls the other flow's draft.",
    example: {
        flowId: '<flow id>',
        call: 'wait',
        parameters: [{ name: 'customerId', value: '$id', expression: true }],
        sendEnvelope: true,
        inputSource: 'data',
    },
    inputs: 1,
    outputs: 1,
    usesOverride: true,
    settings: [
        {
            key: 'flowId',
            label: 'Flow',
            kind: 'flow',
            required: true,
            description: "the called flow's id (the `id` in its file)",
        },
        {
            key: 'flowPath',
            label: 'Flow path',
            kind: 'value',
            required: true,
            default: { value: '', expression: true },
            placeholder: "'Imports/' + $source + '/Load'",
            when: { key: 'flowId', values: [DYNAMIC_TARGET] },
        },
        {
            key: 'call',
            label: 'Call',
            kind: 'select',
            default: 'wait',
            options: [
                { value: 'wait', label: 'Wait for the result' },
                { value: 'fire-and-forget', label: 'Fire and forget (a run of its own per batch)' },
            ],
        },
        {
            key: 'batchSize',
            label: 'Batch size',
            kind: 'number',
            default: DEFAULT_BATCH_SIZE,
            min: 1,
            max: MAX_BATCH_SIZE,
            when: { key: 'call', values: ['fire-and-forget'] },
        },
        {
            key: 'parameters',
            label: 'Parameters',
            kind: 'list',
            itemLabel: 'parameter',
            parametersOf: 'flowId',
            item: [
                { key: 'name', label: 'Name', kind: 'text', required: true },
                { key: 'value', label: 'Value', kind: 'value', spread: true, default: { value: '', expression: false } },
            ],
        },
        {
            key: 'sendEnvelope',
            label: 'Send an input to the flow',
            kind: 'boolean',
            description: "the called flow's Start needs `acceptsInput: true`, or its run fails",
        },
        {
            key: 'inputSource',
            label: 'Input',
            kind: 'select',
            default: 'data',
            options: [
                { value: 'data', label: "The envelope's DATA" },
                { value: 'expression', label: 'An expression' },
            ],
            when: { key: 'sendEnvelope', values: [true] },
        },
        {
            key: 'input',
            label: 'Input expression',
            kind: 'value',
            default: { value: '', expression: true },
            placeholder: '{id: $id, total: $price * $quantity}',
            when: [
                { key: 'sendEnvelope', values: [true] },
                { key: 'inputSource', values: ['expression'] },
            ],
        },
    ],

    validate(config) {
        const { flowId, flowPath, call, sendEnvelope, inputSource, input } = flowInvokerConfig(config);
        if (!flowId) {
            return ['has no flow selected.'];
        }
        if (flowPath && !flowPath.value.trim()) {
            return ['has no flow path.'];
        }
        if (sendEnvelope && inputSource === 'expression' && !input.value.trim()) {
            return ['has no input expression.'];
        }
        return call === 'fire-and-forget' && (config.onError === 'continue' || config.onError === 'divert')
            ? ['fires and forgets: its On error is always Throw (the calls answer nothing to continue or divert with).']
            : [];
    },

    fixedOnError: config => (flowInvokerConfig(config).call === 'fire-and-forget' ? 'throw' : undefined),

    async *execute(inputs, config, ctx) {
        const settings = flowInvokerConfig(config);
        const { parameters, call: how, batchSize } = settings;
        const input = inputOf(settings, ctx);
        const flowOf = targetOf(settings, ctx);
        if (how === 'fire-and-forget') {
            yield* fireAndForget(inputs['in-0'] ?? [], { flowOf, parameters, input, sends: settings.sendEnvelope, batchSize }, ctx);
            return;
        }
        let calls = 0;
        let outputs = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            calls += 1;
            let call: ReturnType<typeof ctx.invokeFlow> | undefined;
            try {
                call = ctx.invokeFlow(flowOf(doc), { parameters: parameterValues(parameters, doc, ctx), input: input(doc) });
                let thisCall = 0;
                for await (const data of ctx.waitEach(call.envelopes)) {
                    thisCall += 1;
                    yield { port: 'out-0', doc: mergeFields(doc, data, ctx.node.override) };
                }
                outputs += thisCall;
                const record = await ctx.wait(call.result);
                if (record.status === 'failed') {
                    throw Object.assign(new Error(`The flow "${record.run.flow}" failed: ${record.error ?? 'no details'}`), {
                        name: 'FlowError',
                    });
                }
                ctx.log(
                    record.status === 'completed' ? 'debug' : 'warning',
                    `Call ${calls}: "${record.run.flow}" ${record.status.replace('-', ' ')} in ${record.durationMs} ms, ${thisCall} envelope(s) at the End.`,
                );
            } catch (e) {
                yield { error: toError(e), doc };
            } finally {
                call?.cancel();
            }
        }
        ctx.log('debug', `${calls} call(s), ${outputs} envelope(s) returned.`);
    },
};

/**
 * Fire and forget: envelopes go on at once and are batched by parameter values; each full batch, and each one left at
 * the end, is one run of the other flow. Near ctx.maxFireAndForgetRuns the batches stop closing on their size. A run
 * (or, in a loop region, an iteration) that ends early (ctx.endedEarly) drops the batches not yet started.
 */
async function* fireAndForget(
    source: AsyncIterable<Envelope>,
    {
        flowOf,
        parameters,
        input,
        sends,
        batchSize,
    }: {
        flowOf: (doc: Envelope) => string;
        parameters: InvokerParameter[];
        input: (doc: Envelope) => unknown;
        sends: boolean;
        batchSize: number;
    },
    ctx: ComponentContext,
): AsyncGenerator<ComponentOutput> {
    type Batch = { flow: string; parameters: Record<string, string>; items: unknown[]; count: number };
    const batches = new Map<string, Batch>();
    const beside: Promise<unknown>[] = [];
    const limit = ctx.maxFireAndForgetRuns ?? Number.POSITIVE_INFINITY;
    let runs = 0;
    let sent = 0;
    let lost = 0;
    let capped = false;
    const dropped = { batches: 0, envelopes: 0 };
    const fire = async (batch: Batch) => {
        // the run ended early: its input was cut off, not ended. A batch already being sent goes; one not started is dropped
        if (ctx.endedEarly()) {
            dropped.batches += 1;
            dropped.envelopes += batch.count;
            return;
        }
        const call = { parameters: batch.parameters, input: sends ? batch.items : undefined };
        try {
            if (ctx.run.mode === 'execution') {
                await ctx.queueFlow(batch.flow, call);
            } else {
                const running = ctx.invokeFlow(batch.flow, { ...call, fireAndForget: true });
                beside.push(
                    (async () => {
                        for await (const _ of running.envelopes) {
                            /* its End's envelopes go nowhere */
                        }
                        await running.result;
                    })().catch(() => {}),
                );
            }
            runs += 1;
            sent += batch.count;
        } catch (e) {
            lost += batch.count;
            ctx.log(
                'error',
                `A batch of ${batch.count} envelope(s) was not ${ctx.run.mode === 'execution' ? 'queued' : 'run'}: ${toError(e).message}`,
            );
        }
    };

    for await (const doc of source) {
        const values = parameterValues(parameters, doc, ctx);
        const data = input(doc);
        const flow = flowOf(doc);
        ctx.checkFlowCall(flow, data);
        const key = JSON.stringify([flow, ...Object.entries(values).sort(([a], [b]) => a.localeCompare(b))]);
        let batch = batches.get(key);
        if (!batch) {
            if (runs + batches.size >= limit) {
                throw new Error(
                    `More than ${limit} fire and forget runs: these parameter values need a batch of their own past the limit (4 × the server's workers).`,
                );
            }
            batch = { flow, parameters: values, items: [], count: 0 };
            batches.set(key, batch);
        }
        // a full batch kept open at the limit takes one more: the runs left are fewer than the batches would need
        if (batch.count >= batchSize && !capped) {
            capped = true;
            ctx.log(
                'warning',
                `Limit of ${limit} fire and forget runs reached (4 × the server's workers): the last batches take more than ${batchSize} envelopes each.`,
            );
        }
        if (sends) {
            batch.items.push(...(Array.isArray(data) ? data : [data]));
        }
        batch.count += 1;
        yield { port: 'out-0', doc };
        // firing it would leave no room for the next batch of these values: it stays open and grows instead
        if (batch.count >= batchSize && runs + batches.size < limit) {
            batches.delete(key);
            await fire(batch);
        }
    }
    for (const batch of batches.values()) {
        await fire(batch);
    }
    if (beside.length) {
        await ctx.wait(Promise.all(beside));
    }
    if (dropped.batches) {
        // in a loop region a Next ends the iteration early too, the run going on
        const ended = ctx.node.loop ? 'iteration' : 'run';
        ctx.log('warning', `${dropped.envelopes} envelope(s) in ${dropped.batches} batch(es) not sent: the ${ended} ended early.`);
    }
    ctx.log(
        'debug',
        ctx.run.mode === 'execution'
            ? `${sent} envelope(s) in ${runs} run(s) queued (fire and forget, batches of up to ${batchSize})${lost ? `; ${lost} not queued` : ''}.`
            : `${sent} envelope(s) in ${runs} call(s) fired beside this test run (a real run queues each batch as a run of its own).`,
    );
}
