import type { OAuthTokenRequest, QueueFlowRequest, RunProgress, RunRecord, SourcedOAuthToken } from '@flowtinus/core';
import type { RunJob } from '#features/runs/run-job';
import type { RunUsage } from '#features/runs/run-queue';

/*
 * What the supervisor and a worker process say to each other (Bun's IPC, as JSON). A worker runs one job at a time and
 * never touches the database: it gets the job (secrets included, kept in its memory for that run only) and answers
 * with the run as it goes and its end. The OAuth 2.0 tokens of its API connections it asks the supervisor (`token`,
 * numbered `ask`), which keeps them in its memory for all its workers; a token the API refused goes with the ask. A
 * Flow Invoker's fire and forget call it asks the supervisor to queue (`queue`, numbered too): the new run's id back.
 */

export type ToWorker =
    | { type: 'run'; job: RunJob }
    | { type: 'cancel'; id: string }
    | { type: 'token'; ask: number; token?: SourcedOAuthToken; error?: string }
    | { type: 'queued'; ask: number; id?: string; error?: string };

export type FromWorker =
    | { type: 'ready' }
    | { type: 'token'; ask: number; request: OAuthTokenRequest }
    | { type: 'queue'; ask: number; runId: string; request: QueueFlowRequest }
    | { type: 'progress'; id: string; progress: RunProgress }
    | { type: 'done'; id: string; record: RunRecord; usage: RunUsage };
