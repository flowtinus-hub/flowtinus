import { Channel } from '../channel';
import { MAX_SUB_RUNS, MAX_FLOW_DEPTH, SUB_RUN_SAMPLE_BYTES, SUB_RUN_SAMPLE_SIZE, SUB_RUNS_TOTAL_SAMPLE_BYTES } from '#engine/constants';
import { samplesWithin } from '#engine/progress-samples';
import { flowRunner } from '#engine/flow-runner';
import { hiddenValues, maskText } from '#engine/component-context';
import { inputIssues } from '../scripts/type-shape';
import { normalizedFlowPath } from '../folders/folder-tree';
import type { FlowExecution } from '#engine/flow-execution';
import type { ComponentContext } from '#types/component-context.type';
import type { EnvelopeData } from '#types/envelope-data.type';
import type { ExecutableFlow } from '#types/executable-flow.type';
import type { ExecutableNode } from '#types/executable-node.type';
import type { ComponentRun, SubRun } from '#types/component-run.type';
import type { RunProgress, RunRecord } from '#types/run-record.type';

type Invoke = ComponentContext['invokeFlow'];

function sentParameters(values: Record<string, string>, options: FlowExecution['options']): Pick<SubRun, 'parameters'> {
    if (Object.keys(values).length === 0) {
        return {};
    }
    const hidden = hiddenValues(options);
    return { parameters: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, maskText(value, hidden)])) };
}

export function resolveFlow(flows: Record<string, ExecutableFlow> | undefined, ref: string): string | undefined {
    if (flows?.[ref]) {
        return ref;
    }
    const wanted = normalizedFlowPath(ref);
    return Object.entries(flows ?? {}).find(([, f]) => f.path !== undefined && normalizedFlowPath(f.path) === wanted)?.[0];
}

export function checkedCall(execution: FlowExecution, flowRef: string, input: unknown) {
    const { wf, options } = execution;
    const above = options.chain ?? [wf.id ?? wf.flow];
    // a flow up the chain (the root is not among the callable ones) is still named: the call is circular, not missing
    const flowId = resolveFlow(options.flows, flowRef) ?? (above.includes(flowRef) ? flowRef : undefined);
    if (!flowId) {
        throw new Error(
            `The flow "${flowRef}" was not found (a flow is named by its whole path: its folders and its name, e.g. Imports/Orders/Load).`,
        );
    }
    const chain = [...above, flowId];
    if (chain.slice(0, -1).includes(flowId)) {
        const name = (id: string) => options.flows?.[id]?.flow ?? (id === chain[0] ? (options.rootName ?? wf.flow) : id);
        throw new Error(`Circular flow call: ${chain.map(name).join(' → ')}.`);
    }
    if (chain.length > MAX_FLOW_DEPTH + 1) {
        throw new Error(`More than ${MAX_FLOW_DEPTH} flows called in sequence.`);
    }
    const child = options.flows![flowId]!;
    if (child.unavailable) {
        throw new Error(`The flow "${child.flow}" cannot be called: ${child.unavailable}`);
    }
    if (input !== undefined && child.inputType) {
        const issues = inputIssues(input, child.inputType.shape);
        if (issues.length) {
            throw Object.assign(
                new Error(`The input does not fit ${child.inputType.name} (the Start of "${child.flow}"): ${issues.join(' ')}`),
                { name: 'InputTypeError' },
            );
        }
    }
    return { chain, child, flowId };
}

export async function queueFlow(
    execution: FlowExecution,
    node: ExecutableNode,
    flowRef: string,
    { parameters, input }: { parameters: Record<string, string>; input?: unknown },
): Promise<{ id: string }> {
    const { wf, options } = execution;
    const { chain, child, flowId } = checkedCall(execution, flowRef, input);
    if (!options.queueFlow) {
        throw new Error('This runner does not queue runs: fire and forget needs a server.');
    }
    const queued = await options.queueFlow({
        flowId,
        parameters,
        ...(input !== undefined ? { input } : {}),
        chain,
        rootName: options.rootName ?? wf.flow,
        nodeId: node.id,
        nodeLabel: node.label,
    });
    const list = (execution.recordOf(node.id).subRuns ??= []);
    if (list.length < MAX_SUB_RUNS) {
        list.push({
            id: queued.id,
            flow: child.flow,
            status: 'queued',
            durationMs: 0,
            fireAndForget: true,
            ...sentParameters(parameters, options),
            ...(Array.isArray(input) ? { envelopes: input.length } : {}),
        });
    }
    return queued;
}

export function invokeFlow(
    execution: FlowExecution,
    node: ExecutableNode,
    flowId: string,
    { parameters: values, input, fireAndForget }: Parameters<Invoke>[1],
): ReturnType<Invoke> {
    const { wf, options, run, control } = execution;
    const { chain, child } = checkedCall(execution, flowId, input);
    const childControl = new AbortController();
    const cancel = () => childControl.abort();
    // the run's Stop, timeout and failure (and an iteration's Next) cancel it too, also when they came first
    const signal = AbortSignal.any([control.signal, childControl.signal]);
    const queue = new Channel<EnvelopeData>();
    const id = crypto.randomUUID();
    const kept = keptSubRun(execution, node, {
        id,
        flow: child.flow,
        ...sentParameters(values, options),
        ...(fireAndForget ? { fireAndForget: true as const, ...(Array.isArray(input) ? { envelopes: input.length } : {}) } : {}),
    });
    const result = flowRunner(child, {
        ...options,
        id,
        parameterValues: values,
        input,
        signal,
        // the timeout is this run's (which cancels the child along with it)
        timeoutMs: undefined,
        parentId: run.id,
        chain,
        rootName: options.rootName ?? wf.flow,
        loop: undefined,
        onReachEnd: doc => queue.send(doc.DATA),
        onProgress: kept?.onProgress,
    })
        .then(
            record => {
                kept?.ended(record);
                return record;
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

/**
 * A sub-run's entry in the component's record (a called flow, a Loop's iteration), for the first MAX_SUB_RUNS of the
 * component only: what keeps it up to date while it runs and when it ends. Past them, nothing (undefined).
 */
export function keptSubRun(execution: FlowExecution, node: ExecutableNode, fields: Omit<SubRun, 'status' | 'durationMs'>) {
    const list = (execution.recordOf(node.id).subRuns ??= []);
    if (list.length >= MAX_SUB_RUNS) {
        return undefined;
    }
    const { id, flow, ...rest } = fields;
    const entry: SubRun = { id, flow, status: 'running', durationMs: 0, ...rest };
    list.push(entry);
    return {
        onProgress: (progress: RunProgress) => {
            entry.durationMs = progress.durationMs;
            entry.record = trimSamples(progress, { bytes: SUB_RUNS_TOTAL_SAMPLE_BYTES });
        },
        ended: (record: RunRecord) =>
            Object.assign(entry, {
                status: record.status,
                durationMs: record.durationMs,
                ...(record.error ? { error: record.error } : {}),
                record: trimSamples(record, execution.subRunSamples),
            }),
        failed: (e: unknown) => Object.assign(entry, { status: 'failed', error: e instanceof Error ? e.message : String(e) }),
    };
}

function trimSamples<T extends RunRecord | RunProgress>(record: T, total: { bytes: number }): T {
    const cut = (sample: EnvelopeData[]) => sample.slice(0, SUB_RUN_SAMPLE_SIZE);
    const cutPorts = (ports: Record<string, EnvelopeData[]>) =>
        Object.fromEntries(Object.entries(ports).map(([port, sample]) => [port, cut(sample)]));
    const components: ComponentRun[] = record.components.map(c => ({
        ...c,
        inputSample: cut(c.inputSample),
        outputSample: cutPorts(c.outputSample),
        ...(c.inputSampleByPort ? { inputSampleByPort: cutPorts(c.inputSampleByPort) } : {}),
    }));
    return {
        ...record,
        components: samplesWithin(components, { perComponent: SUB_RUN_SAMPLE_BYTES, perSubRunComponent: SUB_RUN_SAMPLE_BYTES, total }),
    };
}
