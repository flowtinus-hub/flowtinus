import { COMPONENT_TYPE } from '#components/component-types';
import { Channel, empty } from '../channel';
import { COMPONENTS } from '../components';
import { END, END_SAMPLE_BYTES, RECORD_SAMPLE_BYTES, SAMPLE_SIZE, START, SUB_RUNS_TOTAL_SAMPLE_BYTES } from '#engine/constants';
import { Stopwatch, timedRequests } from '#engine/stopwatch';
import { writesOutside } from '#engine/side-effects';
import { MemoryMeter } from '#engine/memory-meter';
import { flowOrder } from '#engine/flow-order';
import { progressComponents, rememberSize } from '#engine/progress-samples';
import { errorPolicy, withError } from '#engine/error-envelope';
import { mergeSources } from '#engine/merge-sources';
import { ERROR_PORT, outputPorts } from '#validation/ports';
import { componentContext, hiddenValues, maskText } from '#engine/component-context';
import { skippedNodes } from '#engine/run-from';
import { regionFlow } from '#engine/region-flow';
import { RunInterrupted } from '#errors/run-interrupted';
import { toError } from '#errors/normalize-error';
import { errorWithOrigin, messageWithOrigin } from '#errors/error-origin';
import type { ComponentRun } from '#types/component-run.type';
import type { Envelope } from '#types/envelope.type';
import type { EnvelopeData } from '#types/envelope-data.type';
import type { ExecutableNode } from '#types/executable-node.type';
import type { ExecutableFlow } from '#types/executable-flow.type';
import type { LogLevel } from '#types/log-level.type';
import type { ParameterValue } from '#types/parameter.type';
import type { RunOptions } from '#types/run-options.type';
import type { RunProgress, RunRecord } from '#types/run-record.type';
import type { FlowCurrentRun } from '#types/flow-current-run.type';

const PROGRESS_MS = 250;
const STOP_GRACE_MS = 250;

async function drain(source: AsyncIterable<Envelope>) {
    for await (const _ of source) {
        /* dropped */
    }
}

/** Copy of the sample (the envelope moves on and may be changed by another component). */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const STATUS_LABEL: Record<RunRecord['status'], string> = {
    completed: 'completed',
    'with-warnings': 'with warnings',
    'with-errors': 'with errors',
    failed: 'failed',
};

/** One run of a flow: each edge becomes a Channel and all components run at the same time. */
export class FlowExecution {
    readonly run: FlowCurrentRun;
    readonly control = new AbortController();

    private readonly start = Date.now();
    /** the same moment on the high-resolution clock: component times are dates from it, on the run's own clock (a long-lived
     * worker's performance.timeOrigin drifts from Date.now()) */
    private readonly startPerf = performance.now();
    private readonly isoAt = (at: number) => new Date(this.start + (at - this.startPerf)).toISOString();
    private readonly records: Map<string, ComponentRun>;
    private readonly stopwatches: Map<string, Stopwatch>;
    private readonly memories: Map<string, MemoryMeter>;
    private readonly waits: Map<string, Stopwatch>;
    private readonly channels: (ExecutableFlow['edges'][number] & { channel: Channel<Envelope> })[];
    private readonly dropped = new Map<string, Record<string, number>>();
    readonly subRunSamples = { bytes: SUB_RUNS_TOTAL_SAMPLE_BYTES };
    private initialEnvelopes: EnvelopeData[] = [];
    private readonly skipped: Set<string>;
    private failure?: string;

    readonly wf: ExecutableFlow;

    constructor(
        readonly source: ExecutableFlow,
        readonly options: RunOptions,
        readonly parameters: Record<string, ParameterValue>,
    ) {
        const wf = regionFlow(source, options.loop?.id);
        this.wf = wf;
        this.run = {
            id: options.id,
            mode: options.mode,
            workspace: wf.workspace ?? '',
            project: wf.project,
            flow: wf.flow,
            startedAt: new Date(this.start).toISOString(),
            ...(options.parentId ? { parentId: options.parentId } : {}),
        };
        this.records = new Map(
            wf.nodes.map(node => [
                node.id,
                {
                    nodeId: node.id,
                    label: node.label,
                    type: node.type,
                    status: 'not-run',
                    inputs: {},
                    outputs: {},
                    logs: [],
                    inputSample: [],
                    outputSample: {},
                },
            ]),
        );
        this.stopwatches = new Map(wf.nodes.map(node => [node.id, new Stopwatch(true)]));
        this.memories = new Map(wf.nodes.map(node => [node.id, new MemoryMeter()]));
        this.waits = new Map(wf.nodes.map(node => [node.id, new Stopwatch()]));
        // a component's waiting counts only while its own code is not running (stopwatch.ts)
        this.stopwatches.forEach((active, nodeId) => active.pairWaiting(this.waits.get(nodeId)!));
        this.channels = wf.edges.map(e => ({ ...e, channel: new Channel<Envelope>() }));
        this.skipped = skippedNodes(wf, options.mode);
    }

    recordOf(nodeId: string) {
        return this.records.get(nodeId)!;
    }

    private readonly opened = new Map<string, number>();

    /**
     * Marks the component open, once: now (its first envelope), or when it started working if it did real work before
     * (a TypeScript component compiles its script first): what it did counts inside its open time.
     */
    private markOpen(nodeId: string) {
        if (this.opened.has(nodeId)) {
            return;
        }
        const stopwatch = this.stopwatchOf(nodeId);
        const workedBefore = stopwatch.total >= 1 && stopwatch.firstAt !== undefined;
        const at = workedBefore ? stopwatch.firstAt! : performance.now();
        if (!workedBefore) {
            // less than a millisecond of setup before the first envelope: outside its open time, so not in its active time either
            stopwatch.total = 0;
        }
        this.opened.set(nodeId, at);
        this.recordOf(nodeId).start = this.isoAt(at);
    }
    fromOf() {
        const from = this.options.runFrom;
        return from ? { from: { nodeId: from.nodeId, label: from.label } } : {};
    }
    private inputPortsOf(nodeId: string) {
        let count = this.portCounts.get(nodeId);
        if (count === undefined) {
            const ports = new Set(this.channels.filter(c => c.target === nodeId).map(c => c.targetPort));
            if (this.options.runFrom?.nodeId === nodeId) {
                Object.keys(this.options.runFrom.inputs).forEach(p => ports.add(p));
            }
            count = ports.size;
            this.portCounts.set(nodeId, count);
        }
        return count;
    }
    private readonly portCounts = new Map<string, number>();
    stopwatchOf(nodeId: string) {
        return this.stopwatches.get(nodeId)!;
    }
    memoryOf(nodeId: string) {
        return this.memories.get(nodeId)!;
    }
    waitingOf(nodeId: string) {
        return this.waits.get(nodeId)!;
    }

    async execute(initialEnvelopes: EnvelopeData[]): Promise<RunRecord> {
        this.initialEnvelopes = initialEnvelopes;
        const onCancel = () => this.interrupt('Run cancelled.');
        const { signal, timeoutMs } = this.options;
        if (signal?.aborted) {
            onCancel();
        }
        signal?.addEventListener('abort', onCancel);
        const limit = timeoutMs
            ? setTimeout(() => this.interrupt(`Run interrupted: exceeded the maximum time (${Math.round(timeoutMs / 1000)} s).`), timeoutMs)
            : undefined;

        const progress = this.options.onProgress ? setInterval(() => this.options.onProgress?.(this.progress()), PROGRESS_MS) : undefined;
        const all = Promise.all(this.wf.nodes.map(node => this.runNode(node)));
        // Stop or timeout: the components have a moment to end on their own (a call the signal aborts); one still waiting on
        // something that does not listen (a script's own wait) is not waited for: the run ends now, it as stopped
        await Promise.race([all, this.stopped.then(() => Promise.race([all, new Promise(resolve => setTimeout(resolve, STOP_GRACE_MS))]))]);
        this.markStopped();
        clearInterval(progress);

        clearTimeout(limit);
        signal?.removeEventListener('abort', onCancel);

        if (this.failure) {
            return this.finish('failed', this.failure);
        }
        const end = this.wf.nodes.find(n => n.type === END);
        const endRecord = end && this.records.get(end.id);
        const discarded = this.wf.nodes.some(
            n => n.type === COMPONENT_TYPE.discard && Object.values(this.records.get(n.id)?.inputs ?? {}).some(count => count > 0),
        );
        if (endRecord && endRecord.status === 'completed' && !endRecord.inputs['in-0'] && !discarded && !this.cutShortBy) {
            endRecord.status = 'with-warnings';
            endRecord.logs.push({ at: new Date().toISOString(), level: 'warning', message: 'No envelope reached the End.' });
        }

        const status = [...this.records.values()].map(r => r.status);
        return this.finish(
            status.includes('with-errors') ? 'with-errors' : status.includes('with-warnings') ? 'with-warnings' : 'completed',
        );
    }

    finish(status: RunRecord['status'], error?: string): RunRecord {
        const durationMs = Date.now() - this.start;
        const endRecord = this.records.get(this.wf.nodes.find(n => n.type === END)?.id ?? '');
        endRecord?.logs.push({
            at: new Date().toISOString(),
            level: status === 'failed' ? 'error' : status === 'completed' ? 'debug' : 'warning',
            message: `Run ${this.run.id} finished (${STATUS_LABEL[status]}) in ${durationMs} ms.`,
        });
        return {
            run: this.run,
            parameters: this.parameters,
            status,
            error,
            end: new Date().toISOString(),
            durationMs,
            ...this.fromOf(),
            components: flowOrder(this.wf).map(id => this.records.get(id)!),
        };
    }

    progress(): RunProgress {
        return {
            run: this.run,
            parameters: this.parameters,
            status: 'running',
            durationMs: Date.now() - this.start,
            ...this.fromOf(),
            components: structuredClone(progressComponents(flowOrder(this.wf).map(id => this.records.get(id)!))),
        };
    }

    cutShort(reason: string) {
        if (this.failure || this.cutShortBy) {
            return;
        }
        this.cutShortBy = reason;
        this.abortAll();
        this.stop();
    }
    /** what cut this execution short without failing it (a Next ending an iteration) */
    private cutShortBy: string | undefined;

    /** Stops the run (Stop button, timeout): the first reason wins. */
    interrupt(reason: string) {
        this.failure ??= reason;
        this.abortAll();
        this.stop();
    }

    private stop: () => void = () => {};
    private readonly stopped = new Promise<void>(resolve => (this.stop = resolve));

    private markStopped() {
        const reason = this.failure ?? this.cutShortBy;
        if (!reason) {
            return;
        }
        const now = performance.now();
        for (const [nodeId, rec] of this.records) {
            if (rec.status !== 'running') {
                continue;
            }
            rec.status = this.failure ? 'failed' : 'completed';
            rec.logs.push({
                at: new Date().toISOString(),
                level: this.failure ? 'error' : 'debug',
                message: this.failure ? `Stopped while it was running (${this.failure})` : `Stopped while it was running: ${reason}.`,
            });
            const opened = this.opened.get(nodeId) ?? now;
            rec.start ??= this.isoAt(opened);
            rec.end = this.isoAt(now);
            rec.durationMs = Math.round((now - opened) * 100) / 100;
        }
    }

    private abortAll() {
        this.channels.forEach(c => c.channel.abort());
        this.control.abort();
    }

    private inputsOf(nodeId: string) {
        const perPort: Record<string, AsyncIterable<Envelope>[]> = {};
        for (const e of this.channels.filter(c => c.target === nodeId)) {
            (perPort[e.targetPort] ??= []).push(e.channel);
        }
        const from = this.options.runFrom;
        if (from?.nodeId === nodeId) {
            for (const [port, items] of Object.entries(from.inputs)) {
                (perPort[port] ??= []).push(this.envelopesOf(items));
            }
        }
        return Object.fromEntries(
            Object.entries(perPort).map(([port, sources]) => [port, sources.length === 1 ? sources[0] : mergeSources(sources)]),
        );
    }

    private async *envelopesOf(items: EnvelopeData[]): AsyncIterable<Envelope> {
        for (const DATA of items) {
            yield { FLOW_CURRENT_RUN: this.run, PARAMETERS: this.parameters, DATA: clone(DATA) };
        }
    }

    private outputsOf(nodeId: string, port: string) {
        return this.channels.filter(c => c.source === nodeId && c.sourcePort === port).map(c => c.channel);
    }

    /**
     * A copy of an envelope's data for the record's samples, without the run's secrets and tokens: a response that
     * echoes one (an OAuth token in a body) is kept with *** in its place. The envelope itself goes on unchanged.
     */
    private sampled<T>(value: T): { copy: T; bytes: number } {
        const hidden = hiddenValues(this.options);
        const text = JSON.stringify(value);
        if (text === undefined) {
            return { copy: value, bytes: 0 };
        }
        // as each value appears inside JSON text (quotes and backslashes escaped)
        const masked = maskText(
            text,
            hidden.map(v => JSON.stringify(v).slice(1, -1)),
        );
        const copy = JSON.parse(masked) as T;
        rememberSize(copy, masked.length);
        return { copy, bytes: masked.length };
    }

    private readonly sampleBytesLeft = new Map<string, number>();
    private readonly samplesLeftOut = new Map<string, number>();

    /**
     * Keeps a copy of an envelope in one of a component's samples (the first SAMPLE_SIZE envelopes of it), whole, if it
     * fits in what the component's samples may still take. The first one that does not fit ends that sample: the
     * envelopes that would have followed it are only counted (samplesNotKept), so a sample is always the first
     * envelopes, in order, and Run from here knows when it does not have them all. The envelope itself goes on unchanged.
     */
    private keepSample(node: ExecutableNode, sample: EnvelopeData[], list: string, side: 'input' | 'output', value: EnvelopeData) {
        const key = `${node.id}:${list}`;
        const leftOut = this.samplesLeftOut.get(key) ?? 0;
        if (sample.length + leftOut >= SAMPLE_SIZE) {
            return;
        }

        const left = this.sampleBytesLeft.get(node.id) ?? (node.type === END ? END_SAMPLE_BYTES : RECORD_SAMPLE_BYTES);
        if (leftOut === 0) {
            const { copy, bytes } = this.sampled(value);
            if (bytes <= left) {
                sample.push(copy);
                this.sampleBytesLeft.set(node.id, left - bytes);
                return;
            }
        }

        this.samplesLeftOut.set(key, leftOut + 1);
        const rec = this.recordOf(node.id);
        const notKept = (rec.samplesNotKept ??= { input: 0, output: 0 });
        notKept[side] += 1;
    }

    private async send(node: ExecutableNode, port: string, doc: Envelope) {
        const rec = this.recordOf(node.id);
        const stopwatch = this.stopwatchOf(node.id);
        const wasRunning = stopwatch.running;
        stopwatch.stop();
        rec.outputs[port] = (rec.outputs[port] ?? 0) + 1;
        if (this.outputsOf(node.id, port).length === 0) {
            const perPort = this.dropped.get(node.id) ?? {};
            perPort[port] = (perPort[port] ?? 0) + 1;
            this.dropped.set(node.id, perPort);
        }
        this.keepSample(node, (rec.outputSample[port] ??= []), `out:${port}`, 'output', doc.DATA);
        // a port with several edges gives each its own copy: a path that changes the envelope does not touch what another
        // one received. One edge: the envelope itself.
        const channels = this.outputsOf(node.id, port);
        const copies = channels.slice(1).map(() => structuredClone(doc));
        for (const [i, channel] of channels.entries()) {
            await channel.send(i === 0 ? doc : copies[i - 1]!);
        }
        if (wasRunning) {
            stopwatch.resume();
        }
    }

    private async *watchInput(node: ExecutableNode, port: string, source: AsyncIterable<Envelope>) {
        const rec = this.recordOf(node.id);
        const stopwatch = this.stopwatchOf(node.id);
        stopwatch.stop();
        for await (const doc of source) {
            this.markOpen(node.id);
            if (rec.status === 'not-run') {
                rec.status = 'running';
            }
            rec.inputs[port] = (rec.inputs[port] ?? 0) + 1;
            this.keepSample(node, rec.inputSample, 'in', 'input', doc.DATA);
            // several inputs: each one's first envelopes too (Run from here feeds them back to the right input)
            if (this.inputPortsOf(node.id) > 1) {
                const byPort = (rec.inputSampleByPort ??= {});
                this.keepSample(node, (byPort[port] ??= []), `in:${port}`, 'input', doc.DATA);
            }
            stopwatch.resume();
            yield doc;
            stopwatch.stop();
        }
    }

    private async runNode(node: ExecutableNode) {
        const rec = this.recordOf(node.id);
        // an error line the component wrote itself (a Log of level error, a script's log): worth attention, not an error
        // of an envelope; the component ends with warnings, not with errors
        let ownErrorLines = 0;
        let ownWarnings = 0;
        const log = (level: LogLevel, message: string, byComponent = false) => {
            if (byComponent && level === 'error') {
                ownErrorLines += 1;
            }
            rec.logs.push({
                at: new Date().toISOString(),
                level,
                message: maskText(message, hiddenValues(this.options)),
                ...(byComponent ? { byComponent: true as const } : {}),
            });
        };
        const outputPorts = [...new Set(this.channels.filter(c => c.source === node.id).map(c => c.sourcePort))];
        const stopwatch = this.stopwatchOf(node.id);
        const t0 = performance.now();
        let errors = 0;
        let dryRun = false;
        let replayed = false;
        const from = this.options.runFrom?.nodeId === node.id ? this.options.runFrom : undefined;
        if (from) {
            log('debug', `Run from here: ${from.label}.`);
            for (const [port, items] of Object.entries(from.inputs)) {
                const total = from.totals[port] ?? items.length;
                if (total > items.length) {
                    log(
                        'warning',
                        `Only the first ${items.length} of the ${total} envelopes that reached ${port} in the last run came in: a run keeps ${items.length} per port.`,
                    );
                }
            }
        }
        if (this.skipped.has(node.id)) {
            rec.status = 'skipped';
            await Promise.all(Object.values(this.inputsOf(node.id)).map(drain));
            for (const port of outputPorts) {
                for (const channel of this.outputsOf(node.id, port)) {
                    channel.close();
                }
            }
            return;
        }
        if (node.type === START) {
            rec.status = 'running';
        }
        try {
            const inputs = Object.fromEntries(
                Object.entries(this.inputsOf(node.id)).map(([port, source]) => [port, this.watchInput(node, port, source)]),
            );

            const pinned = this.options.mode === 'validation' ? node.pinned : undefined;
            if (node.pinned && !pinned) {
                log('debug', 'Pinned output ignored: in a real run the component always executes.');
            }
            if (pinned) {
                replayed = true;
                log('debug', 'Pinned output: did not execute, the input was dropped and the pinned envelopes went out.');
                // the ports at the same time: a component after it may read one input only after the other
                await Promise.all([
                    ...Object.values(inputs).map(drain),
                    ...Object.entries(pinned).map(async ([port, items]) => {
                        for (const DATA of items) {
                            await this.send(node, port, { FLOW_CURRENT_RUN: this.run, PARAMETERS: this.parameters, DATA: clone(DATA) });
                        }
                    }),
                ]);
            } else if (node.type === START) {
                stopwatch.resume();
                this.markOpen(node.id);
                // before its envelopes go on: what they start (a Loop's first iteration) logs after it
                log('debug', `Run ${this.run.id} started (${this.run.mode})${this.options.input !== undefined ? ' with input' : ''}.`);
                for (const envelope of this.initialEnvelopes) {
                    if (this.options.input !== undefined) {
                        rec.inputs['in-0'] = (rec.inputs['in-0'] ?? 0) + 1;
                        this.keepSample(node, rec.inputSample, 'in', 'input', envelope);
                    }
                    const doc: Envelope = { FLOW_CURRENT_RUN: this.run, PARAMETERS: this.parameters, DATA: envelope };
                    for (const port of outputPorts) {
                        await this.send(node, port, doc);
                    }
                }
            } else if (node.type === END) {
                for (const source of Object.values(inputs)) {
                    for await (const doc of source) {
                        if (this.options.onReachEnd) {
                            await this.options.onReachEnd(doc);
                        }
                    }
                }
            } else if (node.disabled) {
                log('warning', 'Bypass: did not execute, the envelopes passed straight through.');
                for await (const doc of inputs['in-0'] ?? empty<Envelope>()) {
                    await this.send(node, 'out-0', doc);
                }
            } else {
                const logic = COMPONENTS[node.type];
                if (!logic) {
                    throw new Error(`Component "${node.type}" does not exist in the runner.`);
                }
                // THE gate for targets (section 12 of docs/architecture.md): in a test run a component with side effects writes
                // nothing (its ctx sends nothing) and its envelopes go on marked `notSent`, so the rest of the flow (and a
                // called flow's End) is tested too. A pin replays (above).
                dryRun = this.options.mode === 'validation' && writesOutside(logic, node.config);
                const warn = (message: string) => {
                    ownWarnings += 1;
                    log('warning', message, true);
                };
                const ctx = componentContext(this, node, (level, message) => log(level, message, true), dryRun, warn);
                const send = (port: string, doc: Envelope) => this.send(node, port, doc);
                for await (const output of timedRequests(logic.execute(inputs, node.config, ctx), stopwatch)) {
                    if ('port' in output) {
                        await send(output.port, output.doc);
                        continue;
                    }
                    const policy = errorPolicy(node);
                    if (policy === 'divert') {
                        log('warning', `Diverted to the error port: ${messageWithOrigin(output.error)}`);
                        await send(ERROR_PORT, withError(output.doc, output.error, node.label));
                        continue;
                    }
                    errors += 1;
                    log('error', messageWithOrigin(output.error));
                    if (policy === 'throw') {
                        throw new RunInterrupted(errorWithOrigin(node.label, output.error));
                    }
                    if (policy === 'continue') {
                        await send('out-0', output.doc);
                    }
                }
                if (dryRun) {
                    log('debug', 'Test run: nothing was written; the envelopes went on marked notSent. Run for real to write.');
                }
            }
            const lost = this.reportDropped(node, log);
            rec.status =
                errors > 0
                    ? 'with-errors'
                    : replayed
                      ? 'pinned'
                      : node.disabled
                        ? 'disabled'
                        : lost || ownErrorLines > 0 || ownWarnings > 0
                          ? 'with-warnings'
                          : 'completed';
        } catch (e) {
            // ended early (Next): what the stop broke is not a failure
            if (this.cutShortBy && !this.failure) {
                rec.status = 'completed';
                log('debug', `Stopped while it was running: ${this.cutShortBy}.`);
                return;
            }
            rec.status = 'failed';
            const error = toError(e);
            if (!(e instanceof RunInterrupted)) {
                log('error', messageWithOrigin(error));
            }
            this.failure ??= e instanceof RunInterrupted ? error.message : errorWithOrigin(node.label, error);
            this.abortAll();
        } finally {
            stopwatch.stop();
            rec.activeTimeMs = Math.round(stopwatch.total * 100) / 100;
            rec.memory = this.memoryOf(node.id).summary;
            const waiting = this.waitingOf(node.id).total;
            if (waiting > 0) {
                rec.waitingMs = Math.round(waiting * 100) / 100;
            }
            const opened = this.opened.get(node.id) ?? t0;
            const now = performance.now();
            rec.start = this.isoAt(opened);
            rec.end = this.isoAt(now);
            rec.durationMs = Math.round((now - opened) * 100) / 100;
            for (const port of outputPorts) {
                for (const channel of this.outputsOf(node.id, port)) {
                    channel.close();
                }
            }
        }
    }

    private reportDropped(node: ExecutableNode, log: (level: LogLevel, message: string) => void) {
        const defined = COMPONENTS[node.type]?.optionalOutputs ?? [];
        const optional = typeof defined === 'function' ? defined(node.config) : defined;
        const names = new Map(outputPorts(node.type, node.config).map(p => [p.id, p.label ?? p.id]));
        for (const port of optional) {
            const n = this.dropped.get(node.id)?.[port];
            if (!n) {
                continue;
            }
            log('debug', `${n} envelope(s) dropped by the output ${names.get(port) ?? port}, which is not connected.`);
            delete this.dropped.get(node.id)![port];
        }
        if (this.dropped.get(node.id) && Object.keys(this.dropped.get(node.id)!).length === 0) {
            this.dropped.delete(node.id);
        }
        const lost = this.dropped.get(node.id);
        if (lost) {
            for (const [port, n] of Object.entries(lost)) {
                log('warning', `${n} envelope(s) dropped: the ${port === 'out-0' ? 'main' : port} output is not connected.`);
            }
        }
        return lost;
    }
}
