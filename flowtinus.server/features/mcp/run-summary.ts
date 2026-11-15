import { END, type ComponentRun, type EnvelopeData, type RunProgress, type RunRecord, type SubRun, type WriteCounts } from '@flowtinus/core';
import type { RunView } from '#features/runs/get-run/get-run-handler';

/*
 * A run as an agent reads it (test_run, get_run): its status and, per component, how many envelopes went in and out of
 * each port, its errors, what it wrote, the flows it called and a few envelopes. Never the whole record: an agent's
 * context is small, a run's record is not. An envelope too large for the summary is shrunk, still valid JSON (long lists,
 * texts and objects cut, each cut marked "…+N items"); get_run_output pages through the envelopes the record has, whole.
 * A Flow Invoker's calls (subRuns) are summarized the same way from the record the caller keeps of each one: get_run and
 * get_run_output take the path of sub-run ids down to the one wanted (a call of a call...).
 */

export const MAX_SAMPLE = 10;
export const MAX_ENVELOPE_CHARS = 12 * 1024;
export const MAX_ERRORS = 5;
export const MAX_SUB_RUNS_LISTED = 20;
export const MAX_OUTPUT_PAGE = 50;
export const MAX_OUTPUT_CHARS = 256 * 1024;

export type SubRunSummary = {
    id: string;
    flow: string;
    iteration?: SubRun['iteration'];
    status: SubRun['status'];
    durationMs: number;
    envelopesAtEnd?: number;
    firstError?: string;
    /** the caller did not wait for it; in a real run it is a run of its own (get_run with its id as runId) */
    fireAndForget?: true;
    envelopes?: number;
    /** no record of it here (past the calls a record keeps, or a run of its own) */
    noRecord?: true;
};

export type ComponentSummary = {
    nodeId: string;
    label: string;
    type: string;
    status: ComponentRun['status'];
    durationMs?: number;
    in: Record<string, number>;
    out: Record<string, number>;
    errors: number;
    errorMessages?: string[];
    logs?: string[];
    writes?: Record<string, WriteCounts>;
    subRuns?: SubRunSummary[];
    moreSubRuns?: number;
    sample?: Record<string, unknown[]>;
    /** envelopes of `sample` shrunk to fit (marked …+N): get_run_output gives them whole */
    shrunk?: number;
};

export type RunSummary = {
    runId: string;
    flowId: string;
    mode: 'validation' | 'execution';
    status: RunView['status'];
    durationMs?: number;
    error?: string;
    components: ComponentSummary[];
    editorUrl?: string;
};

export type SubRunView = Omit<RunSummary, 'flowId' | 'editorUrl'> & {
    flow: string;
    subRunPath: string[];
    note: string;
};

const json = (value: unknown) => JSON.stringify(value) ?? 'null';

const CUTS = [
    { items: 50, text: 2000, keys: 100, depth: 12 },
    { items: 20, text: 500, keys: 50, depth: 8 },
    { items: 10, text: 200, keys: 30, depth: 6 },
    { items: 5, text: 100, keys: 20, depth: 5 },
    { items: 3, text: 60, keys: 10, depth: 4 },
    { items: 1, text: 40, keys: 5, depth: 3 },
    { items: 0, text: 20, keys: 3, depth: 2 },
];

function cut(value: unknown, limits: (typeof CUTS)[number], depth: number): unknown {
    if (typeof value === 'string') {
        return value.length > limits.text ? `${value.slice(0, limits.text)}…+${value.length - limits.text} chars` : value;
    }
    if (Array.isArray(value)) {
        if (depth >= limits.depth) {
            return `[…${value.length} items]`;
        }
        const kept = value.slice(0, limits.items).map(item => cut(item, limits, depth + 1));
        return value.length > limits.items ? [...kept, `…+${value.length - limits.items} items`] : kept;
    }
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value);
        if (depth >= limits.depth) {
            return `{…${entries.length} keys}`;
        }
        const kept: Record<string, unknown> = Object.fromEntries(
            entries.slice(0, limits.keys).map(([key, item]) => [key, cut(item, limits, depth + 1)]),
        );
        if (entries.length > limits.keys) {
            kept['…'] = `+${entries.length - limits.keys} keys`;
        }
        return kept;
    }
    return value;
}

/**
 * The value as it is when its JSON fits in `maxChars`; otherwise shrunk, still valid JSON: lists keep their first items
 * and end with "…+N items", texts their start and "…+N chars", objects their first keys and "…": "+N keys", what is too
 * deep "[…N items]" or "{…N keys}", each try cutting harder until it fits (at last, only its size).
 */
export function shrinkJson(value: unknown, maxChars: number): { value: unknown; shrunk: boolean } {
    const length = json(value).length;
    if (length <= maxChars) {
        return { value, shrunk: false };
    }
    for (const limits of CUTS) {
        const smaller = cut(value, limits, 0);
        if (json(smaller).length <= maxChars) {
            return { value: smaller, shrunk: true };
        }
    }
    return { value: `…${length} chars of JSON`, shrunk: true };
}

const atEnd = (record: RunRecord | RunProgress) =>
    record.components.filter(c => c.type === END).reduce((n, c) => n + Object.values(c.inputs).reduce((a, b) => a + b, 0), 0);

function firstErrorOf(record: RunRecord | RunProgress): string | undefined {
    if ('error' in record && record.error) {
        return record.error;
    }
    for (const c of record.components) {
        const line = c.logs.find(l => l.level === 'error' && !l.byComponent);
        if (line) {
            return `"${c.label}": ${line.message}`;
        }
    }
    return undefined;
}

function subRunSummary(sub: SubRun): SubRunSummary {
    const firstError = sub.error ?? (sub.record ? firstErrorOf(sub.record) : undefined);
    return {
        id: sub.id,
        flow: sub.flow,
        ...(sub.iteration ? { iteration: sub.iteration } : {}),
        status: sub.status,
        durationMs: sub.durationMs,
        ...(sub.record ? { envelopesAtEnd: atEnd(sub.record) } : { noRecord: true as const }),
        ...(firstError ? { firstError } : {}),
        ...(sub.fireAndForget ? { fireAndForget: true as const } : {}),
        ...(sub.envelopes !== undefined ? { envelopes: sub.envelopes } : {}),
    };
}

function summarize(c: ComponentRun, sample: number): ComponentSummary {
    // the errors of envelopes and of the component (the engine's lines); what the component logged itself, even at
    // level error (a Log, a script's log), is one of its logs, not an error
    const errorLines = c.logs.filter(l => l.level === 'error' && !l.byComponent);
    const ownLogs = c.logs.filter(l => l.byComponent).slice(0, MAX_ERRORS);
    const ports = Object.entries(c.outputSample ?? {}).filter(([, items]) => items.length > 0);
    const samples = sample > 0 ? (ports.length ? ports : c.inputSample?.length ? [['input', c.inputSample] as const] : []) : [];
    let shrunk = 0;
    const fit = (data: EnvelopeData) => {
        const result = shrinkJson(data, MAX_ENVELOPE_CHARS);
        shrunk += result.shrunk ? 1 : 0;
        return result.value;
    };
    const sampled = samples.length ? Object.fromEntries(samples.map(([port, items]) => [port, items.slice(0, sample).map(fit)])) : null;
    const calls = c.subRuns ?? [];
    return {
        nodeId: c.nodeId,
        label: c.label,
        type: c.type,
        status: c.status,
        ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
        in: c.inputs,
        out: c.outputs,
        errors: errorLines.length,
        ...(errorLines.length ? { errorMessages: errorLines.slice(0, MAX_ERRORS).map(l => l.message) } : {}),
        ...(ownLogs.length ? { logs: ownLogs.map(l => `${l.level}: ${l.message}`) } : {}),
        ...(c.writes && Object.keys(c.writes).length ? { writes: c.writes } : {}),
        ...(calls.length ? { subRuns: calls.slice(0, MAX_SUB_RUNS_LISTED).map(subRunSummary) } : {}),
        ...(calls.length > MAX_SUB_RUNS_LISTED ? { moreSubRuns: calls.length - MAX_SUB_RUNS_LISTED } : {}),
        ...(sampled ? { sample: sampled } : {}),
        ...(shrunk ? { shrunk } : {}),
    };
}

const sampleSize = (sample: number) => Math.max(0, Math.min(MAX_SAMPLE, Math.floor(sample)));

export function runSummary(run: RunView, sample = 5, editorUrl?: string): RunSummary {
    const record = (run.record as RunRecord | RunProgress | null) ?? null;
    const n = sampleSize(sample);
    return {
        runId: run.id,
        flowId: run.flowId,
        mode: run.mode,
        status: run.status,
        ...(record?.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
        ...(record && 'error' in record && record.error ? { error: record.error } : {}),
        components: (record?.components ?? []).map(c => summarize(c, n)),
        ...(editorUrl ? { editorUrl } : {}),
    };
}

export const subRunPathOf = (subRunId: string | string[] | undefined): string[] =>
    subRunId === undefined ? [] : (Array.isArray(subRunId) ? subRunId : [subRunId]).map(id => id.trim()).filter(Boolean);

export type FoundSubRun = { sub: SubRun; record: RunRecord | RunProgress; path: string[] };

export function findSubRun(
    record: RunRecord | RunProgress | null,
    path: string[],
): { ok: true; value: FoundSubRun } | { ok: false; error: string } {
    let current = record;
    let found: SubRun | undefined;
    for (const [depth, id] of path.entries()) {
        const calls = (current?.components ?? []).flatMap(c => c.subRuns ?? []);
        found = calls.find(s => s.id === id);
        const where = depth === 0 ? 'the run' : `the sub-run ${path[depth - 1]}`;
        if (!found) {
            const known = calls.slice(0, 5).map(s => `${s.id} (${s.flow})`);
            return {
                ok: false,
                error: `No call ${id} in ${where}${known.length ? `: its calls are ${known.join(', ')}${calls.length > 5 ? '...' : ''}` : ' (it called no flow)'}.`,
            };
        }
        if (!found.record) {
            return {
                ok: false,
                error: found.fireAndForget
                    ? `The call ${id} was fire and forget: it is a run of its own (get_run with runId ${id}).`
                    : `The call ${id} has no record here (a record keeps the first calls of each Flow Invoker).`,
            };
        }
        current = found.record;
    }
    return found && current ? { ok: true, value: { sub: found, record: current, path } } : { ok: false, error: 'No sub-run named.' };
}

export function subRunSummaryView(run: RunView, found: FoundSubRun, sample = 5): SubRunView {
    const { sub, record, path } = found;
    const error = sub.error ?? ('error' in record ? record.error : undefined);
    return {
        runId: run.id,
        flow: sub.flow,
        subRunPath: path,
        mode: run.mode,
        status: sub.status,
        durationMs: sub.durationMs,
        ...(error ? { error } : {}),
        components: record.components.map(c => summarize(c, sampleSize(sample))),
        note: "A called flow's record keeps its first envelopes per port only (fewer than a run's own).",
    };
}

function samplesOf(
    c: ComponentRun,
    port: string | undefined,
): { port: string; side: 'output' | 'input'; items: EnvelopeData[]; total: number } | null {
    const sum = (ports: Record<string, number>) => Object.values(ports).reduce((a, b) => a + b, 0);
    const wanted = port ?? Object.entries(c.outputSample).find(([, items]) => items.length > 0)?.[0] ?? 'input';
    if (wanted in c.outputSample || wanted in c.outputs) {
        return { port: wanted, side: 'output', items: c.outputSample[wanted] ?? [], total: c.outputs[wanted] ?? 0 };
    }
    if (wanted === 'input') {
        return { port: 'input', side: 'input', items: c.inputSample, total: sum(c.inputs) };
    }
    if (c.inputSampleByPort?.[wanted] || wanted in c.inputs) {
        return { port: wanted, side: 'input', items: c.inputSampleByPort?.[wanted] ?? [], total: c.inputs[wanted] ?? 0 };
    }
    return null;
}

export type RunOutputPage = {
    runId: string;
    subRunPath?: string[];
    nodeId: string;
    label: string;
    port: string;
    total: number;
    inRecord: number;
    leftOut: number;
    offset: number;
    envelopes: unknown[];
    shrunk?: number[];
    next?: number;
};

export function runOutputPage(
    record: RunRecord | RunProgress | null,
    where: { runId: string; nodeId: string; port?: string; offset: number; limit: number; subRunPath?: string[] },
): { ok: true; value: RunOutputPage } | { ok: false; error: string } {
    const c = record?.components.find(x => x.nodeId === where.nodeId);
    if (!c) {
        const ids = (record?.components ?? []).map(x => x.nodeId);
        return { ok: false, error: `No component ${where.nodeId} in this run${ids.length ? ` (its components: ${ids.join(', ')})` : ''}.` };
    }
    const found = samplesOf(c, where.port);
    if (!found) {
        const ports = [...new Set([...Object.keys(c.outputs), ...Object.keys(c.outputSample)])];
        return {
            ok: false,
            error: `${c.label} has no port ${where.port}: its outputs are ${ports.join(', ') || 'none'}; "input" reads what came in.`,
        };
    }
    const limit = Math.max(1, Math.min(MAX_OUTPUT_PAGE, Math.floor(where.limit)));
    const offset = Math.max(0, Math.floor(where.offset));
    const envelopes: unknown[] = [];
    const shrunk: number[] = [];
    let chars = 0;
    let i = offset;
    for (; i < found.items.length && envelopes.length < limit; i++) {
        const data = found.items[i];
        const size = json(data).length;
        if (envelopes.length === 0 && size > MAX_OUTPUT_CHARS) {
            envelopes.push(shrinkJson(data, MAX_OUTPUT_CHARS).value);
            shrunk.push(i);
            chars = MAX_OUTPUT_CHARS;
            continue;
        }
        if (chars + size > MAX_OUTPUT_CHARS) {
            break;
        }
        envelopes.push(data);
        chars += size;
    }
    return {
        ok: true,
        value: {
            runId: where.runId,
            ...(where.subRunPath?.length ? { subRunPath: where.subRunPath } : {}),
            nodeId: c.nodeId,
            label: c.label,
            port: found.port,
            total: found.total,
            inRecord: found.items.length,
            leftOut: Math.max(0, found.total - found.items.length),
            offset,
            envelopes,
            ...(shrunk.length ? { shrunk } : {}),
            ...(i < found.items.length ? { next: i } : {}),
        },
    };
}
