import type { RunProgress } from '#types/run-record.type';
import type { RunFromPlan } from '#engine/run-from';
import type { ConnectionProfileData } from '../connections/connection-access';
import type { OAuthTokenSource } from '../connections/oauth-token-cache';
import type { Envelope } from '#types/envelope.type';
import type { EvaluateExpression } from '#types/evaluate-expression.type';
import type { ExecutableFlow } from '#types/executable-flow.type';
import type { PrepareScript } from '#types/prepare-script.type';
import type { DatabaseKind } from '#types/database-kind.type';
import type { QueryDatabase } from '#types/query-database.type';
import type { WriteRows } from '#types/row-write.type';
import type { ExecuteSql } from '#types/sql-execute.type';
import type { RunMode } from '#types/run-mode.type';
import type { DocumentStoreKind } from '#types/document-store-kind.type';
import type { UpsertDocuments } from '#types/upsert-documents.type';
import type { AggregateDocuments } from '#types/aggregate-documents.type';
import type { DeleteDocuments } from '#types/delete-documents.type';
import type { SendHttp } from '#types/send-http.type';
import type { QueueFlow } from '#types/queue-flow.type';
import type { LoopControl } from '#types/loop-control.type';

export type RunOptions = {
    mode: RunMode;
    id: string;
    parameterValues?: Record<string, string>;
    /**
     * Flow input (e.g. a webhook body). Only valid if the Start is marked as "accepts input".
     * An object becomes the DATA fields; an array becomes one envelope per item; any other value becomes DATA.input.
     */
    input?: unknown;
    evaluate: EvaluateExpression;
    prepareScript?: PrepareScript;
    databases?: Partial<Record<DatabaseKind, QueryDatabase>>;
    databaseWrites?: Partial<Record<DatabaseKind, WriteRows>>;
    databaseExecutes?: Partial<Record<DatabaseKind, ExecuteSql>>;
    documentStores?: Partial<Record<DocumentStoreKind, UpsertDocuments>>;
    documentQueries?: Partial<Record<DocumentStoreKind, AggregateDocuments>>;
    documentDeletes?: Partial<Record<DocumentStoreKind, DeleteDocuments>>;
    http?: SendHttp;
    flows?: Record<string, ExecutableFlow>;
    /**
     * a Flow Invoker's fire and forget call in a real run: queues the called flow as a run of its own (its id back);
     * without it, such a call is an error of the envelope. A test run never queues: the call runs beside the run.
     */
    queueFlow?: QueueFlow;
    /**
     * The most runs one Flow Invoker fires and forgets in this run (its batches): past it, the batches left grow instead
     * of making more runs. The server sets it from its workers (4 × WORKERS); without it, no limit.
     */
    maxFireAndForgetRuns?: number;
    parentId?: string;
    chain?: string[];
    rootName?: string;
    onReachEnd?: (doc: Envelope) => Promise<void>;
    secrets?: Record<string, string>;
    /**
     * the run as it goes, a few times a second: each component's status (running, then how it ended), counts, samples
     * and logs so far (what the editor shows live). A copy: changing it changes nothing in the run.
     */
    onProgress?: (progress: RunProgress) => void;
    variables?: Record<string, string>;
    connections?: Record<string, ConnectionProfileData>;
    /**
     * where the OAuth 2.0 tokens of the run's API connections come from (and a refused one goes back): by default the
     * memory of the run's own process (oauth-token-cache.ts); a worker's runs ask their supervisor
     */
    oauthTokens?: OAuthTokenSource;
    runFrom?: RunFromPlan;
    loop?: { id: string; index: number; reach: (control: LoopControl, doc: Envelope) => void };
    signal?: AbortSignal;
    timeoutMs?: number;
};
