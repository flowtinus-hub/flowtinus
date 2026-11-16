import { ERROR_PORT, type RunProgress, type RunRecord, type SubRun, type WriteCounts } from '@flowtinus/core';
import type { RunView } from '#features/runs/get-run/get-run-handler';
import { atEnd, endsOf, MAX_ENVELOPE_CHARS, runSummary, sampleSize, shrinkJson, subRunSummaryView, type FoundSubRun, type RunSummary, type SubRunView } from './run-summary';

export type RunDetail = 'result' | 'summary';

type RunOf = { runId: string; flowId: string; subRunPath?: string[]; flow?: string };

export type RunResult = RunOf & {
    status: RunView['status'];
    durationMs?: number;
    error?: string;
    output: unknown[];
    outputCount: number;
    shrunk?: number;
    writes?: Record<string, WriteCounts>;
    logs?: string[];
};

type RunRecordSoFar = RunRecord | RunProgress;

const pending = (status: SubRun['status']) => status === 'queued' || status === 'running';

function noErrorIn(record: RunRecordSoFar): boolean {
    return record.components.every(
        c =>
            // a component's own error line (a Log, console.error) is not an envelope in error
            !c.logs.some(l => l.level === 'error' && !l.byComponent) &&
            !c.outputs[ERROR_PORT] &&
            (c.subRuns ?? []).every(
                // a fire-and-forget call still going is not part of the outcome
                sub => (sub.fireAndForget && pending(sub.status)) || (sub.status === 'completed' && (!sub.record || noErrorIn(sub.record))),
            ),
    );
}

const isClean = (status: string, record: RunRecordSoFar | null) => status === 'completed' && (!record || noErrorIn(record));

const MAX_RESULT_LOGS = 10;

function* recordsIn(record: RunRecordSoFar, flows: string[] = []): Generator<{ record: RunRecordSoFar; flows: string[] }> {
    yield { record, flows };
    for (const sub of record.components.flatMap(c => c.subRuns ?? [])) {
        if (sub.record) {
            yield* recordsIn(sub.record, [...flows, sub.flow]);
        }
    }
}

function writesOf(record: RunRecordSoFar): Record<string, WriteCounts> {
    const total: Record<string, WriteCounts> = {};
    for (const { record: r } of recordsIn(record)) {
        for (const [table, counts] of r.components.flatMap(c => Object.entries(c.writes ?? {}))) {
            const sum = (total[table] ??= { inserted: 0, updated: 0, deleted: 0, affected: 0, batches: 0, failed: 0 });
            for (const key of Object.keys(sum) as (keyof WriteCounts)[]) {
                sum[key] += counts[key] ?? 0;
            }
        }
    }
    return total;
}

function userLogsOf(record: RunRecordSoFar): string[] {
    const lines = [...recordsIn(record)].flatMap(({ record: r, flows }) =>
        r.components.flatMap(c =>
            c.logs
                .filter(l => l.byComponent && (l.level === 'warning' || l.level === 'error'))
                .map(l => `${l.level} (${[...flows, c.label].join(' › ')}): ${l.message}`),
        ),
    );
    return lines.length > MAX_RESULT_LOGS ? [...lines.slice(0, MAX_RESULT_LOGS), `…+${lines.length - MAX_RESULT_LOGS} logs`] : lines;
}

function runResult(of: RunOf, status: RunView['status'], record: RunRecordSoFar | null, sample: number): RunResult {
    const reached = record ? endsOf(record) : [];
    let shrunk = 0;
    const output = reached
        .flatMap(c => c.inputSample)
        .slice(0, sampleSize(sample))
        .map(data => {
            const fit = shrinkJson(data, MAX_ENVELOPE_CHARS);
            shrunk += fit.shrunk ? 1 : 0;
            return fit.value;
        });
    const error = record && 'error' in record ? record.error : undefined;
    const writes = record ? writesOf(record) : {};
    const logs = record ? userLogsOf(record) : [];
    return {
        ...of,
        status,
        ...(record?.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
        ...(error ? { error } : {}),
        output,
        outputCount: record ? atEnd(record) : 0,
        ...(shrunk ? { shrunk } : {}),
        ...(Object.keys(writes).length ? { writes } : {}),
        ...(logs.length ? { logs } : {}),
    };
}

export function runAnswer(run: RunView, options: { detail?: RunDetail; sample: number; editorUrl?: string }): RunResult | RunSummary {
    const record = (run.record as RunRecordSoFar | null) ?? null;
    const detail = options.detail ?? (isClean(run.status, record) ? 'result' : 'summary');
    return detail === 'summary'
        ? runSummary(run, options.sample, options.editorUrl)
        : runResult({ runId: run.id, flowId: run.flowId }, run.status, record, options.sample);
}

export function subRunAnswer(run: RunView, found: FoundSubRun, options: { detail?: RunDetail; sample: number }): RunResult | SubRunView {
    const { sub, record } = found;
    const detail = options.detail ?? (isClean(sub.status, record) ? 'result' : 'summary');
    if (detail === 'summary') {
        return subRunSummaryView(run, found, options.sample);
    }
    const result = runResult(
        { runId: run.id, flowId: run.flowId, subRunPath: found.path, flow: sub.flow },
        sub.status,
        record,
        options.sample,
    );
    return { ...result, durationMs: sub.durationMs, ...(sub.error && !result.error ? { error: sub.error } : {}) };
}
