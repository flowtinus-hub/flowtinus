import type { ConnectionUse } from '../connections/connection-access';
import type { Envelope } from '#types/envelope.type';
import type { ExecutableNode } from '#types/executable-node.type';
import type { ExpressionField } from '#types/expression-field.type';
import type { LogLevel } from '#types/log-level.type';
import type { RunRecord } from '#types/run-record.type';
import type { ScriptFunction } from '#types/script-function.type';
import type { DatabaseKind } from '#types/database-kind.type';
import type { DatabaseQuery } from '#types/database-query.type';
import type { RowWrite, RowWriteAnswer } from '#types/row-write.type';
import type { SqlExecute, SqlExecuteAnswer } from '#types/sql-execute.type';
import type { FlowCurrentRun } from '#types/flow-current-run.type';
import type { EnvelopeData } from '#types/envelope-data.type';
import type { DocumentStoreKind } from '#types/document-store-kind.type';
import type { DocumentBatch } from '#types/document-batch.type';
import type { UpsertAnswer } from '#types/upsert-answer.type';
import type { DocumentQuery } from '#types/document-query.type';
import type { DocumentDelete } from '#types/document-delete.type';
import type { HttpRequest } from '#types/http-request.type';
import type { HttpResponse } from '#types/http-response.type';
import type { ParameterValue } from '#types/parameter.type';
import type { HttpRetry } from '#engine/http-retry';
import type { WriteCounts } from '#types/write-counts.type';
import type { LoopControl } from '#types/loop-control.type';
import type { IterationOf } from '#types/component-run.type';

export type ComponentContext = {
    run: FlowCurrentRun;
    /** the run's Start parameters (what $PARAMETERS holds), for an envelope a component makes with no input (an empty Aggregate) */
    parameters?: Record<string, ParameterValue>;
    node: ExecutableNode;
    prepareScript: (code: string) => Promise<ScriptFunction>;
    fieldValue: (field: ExpressionField, doc: Envelope, variables?: Record<string, unknown>) => unknown;
    log: (level: LogLevel, message: string) => void;
    warn: (message: string) => void;
    /**
     * Runs one iteration of the Loop (this component): its loop region as an inner flow of its own, from Iteration start
     * with the loop state (ADR 0002). `envelopes` yields each envelope that reaches Iteration end, as it arrives; `result`
     * is the iteration's record, whether an envelope reached a Break, how many reached a Continue with and the first of
     * them (the next loop state), and whether a Next cut the iteration short.
     * A caller that stops reading before the end calls `cancel`.
     */
    runIteration: (
        state: Envelope,
        iteration: IterationOf,
    ) => {
        envelopes: AsyncIterable<Envelope>;
        result: Promise<{ record: RunRecord; broke: boolean; continues: number; nextState?: Envelope; cutShort: boolean }>;
        cancel: () => void;
    };
    reachLoop: (control: LoopControl, doc: Envelope) => void;
    /**
     * Waits for something that is not an input (e.g. an internal signal of the component). Use it instead of a direct
     * `await`, so this wait does not count as active time. The engine already discounts waiting for inputs by itself.
     */
    wait: <T>(promise: Promise<T>) => Promise<T>;
    waitEach: <T>(source: AsyncIterable<T>) => AsyncIterable<T>;
    /**
     * Whether the run ended early (Stop, its timeout, a component failing with On error = Throw), or, in a loop region,
     * the iteration did (also a Next). An input cut off by an early end just ends, like one that ended normally: a
     * component that does something once its input ends asks this.
     */
    endedEarly: () => boolean;
    /**
     * How many envelopes the component is holding right now (e.g. the Lookup table, the Aggregate batch). The engine keeps
     * the peak. Pass the envelope you just stored: the engine measures some of them to estimate the size.
     */
    holding: (envelopes: number, held?: Envelope) => void;
    /**
     * Runs another flow (Flow Invoker) with the values of its Start parameters and, optionally, an input.
     * `envelopes` yields the DATA of each envelope that reaches its End, as it arrives; `result` is its record.
     * A caller that stops reading before the end calls `cancel`. `fireAndForget`: the caller does not wait for it (its
     * entry in the record says so).
     */
    invokeFlow: (
        flowId: string,
        call: { parameters: Record<string, string>; input?: unknown; fireAndForget?: boolean },
    ) => {
        envelopes: AsyncIterable<EnvelopeData>;
        result: Promise<RunRecord>;
        cancel: () => void;
    };
    queueFlow: (flowId: string, call: { parameters: Record<string, string>; input?: unknown }) => Promise<{ id: string }>;
    checkFlowCall: (flowId: string, input?: unknown) => void;
    maxFireAndForgetRuns?: number;
    queryDatabase: (
        kind: DatabaseKind,
        query: Omit<DatabaseQuery, 'connection' | 'signal'> & { connection: ConnectionUse },
    ) => AsyncIterable<Record<string, unknown>>;
    aggregateDocuments: (
        kind: DocumentStoreKind,
        query: Omit<DocumentQuery, 'connection' | 'signal'> & { connection: ConnectionUse },
    ) => AsyncIterable<Record<string, unknown>>;
    /** In a test run of a component with side effects it writes nothing: it logs what it would send and answers null. */
    writeRows: (
        kind: DatabaseKind,
        write: Omit<RowWrite, 'connection' | 'signal'> & { connection: ConnectionUse },
    ) => Promise<RowWriteAnswer | null>;
    executeSql: (
        kind: DatabaseKind,
        execute: Omit<SqlExecute, 'connection' | 'signal'> & { connection: ConnectionUse },
    ) => Promise<SqlExecuteAnswer | null>;
    upsertDocuments: (
        kind: DocumentStoreKind,
        batch: Omit<DocumentBatch, 'connection' | 'signal'> & { connection: ConnectionUse },
    ) => Promise<UpsertAnswer | null>;
    deleteDocuments: (
        kind: DocumentStoreKind,
        request: Omit<DocumentDelete, 'connection' | 'signal' | 'countOnly'> & { connection: ConnectionUse },
    ) => Promise<{ deleted: number } | { notSent: true; matched: number }>;
    /**
     * Sends an HTTP request through the runner's function (fetch); `auth`, an API connection, adds its headers; `retry`:
     * on its statuses (429, 503) it waits (Retry-After or a backoff, see engine/http-retry.ts) and sends it again. In a test run of a component that writes (e.g. a POST)
     * it sends nothing: it logs the method, the URL and an excerpt of the body, with the secrets hidden, and answers null.
     */
    sendHttp: (request: Omit<HttpRequest, 'signal'> & { auth?: ConnectionUse; retry?: HttpRetry }) => Promise<HttpResponse | null>;
    mask: (text: string) => string;
    wrote: (target: string, counts: Partial<WriteCounts>) => void;
};
