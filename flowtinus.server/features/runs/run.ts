import { bigint, boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { jsonb } from '#shared/database/jsonb';
import { workspaces } from '#features/workspaces/workspace';
import { projects } from '#features/projects/project';

/** the columns of both run tables (a function: each table needs its own column builders) */
const runColumns = () => ({
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id),
    flowId: uuid('flow_id').notNull(),
    projectId: uuid('project_id').references(() => projects.id),
    parentId: uuid('parent_id'),
    mode: text('mode').$type<'execution' | 'validation'>().notNull(),
    flowVersionId: uuid('flow_version_id'),
    draftHash: text('draft_hash'),
    status: text('status').$type<RunRowStatus>().notNull(),
    trigger: text('trigger').$type<'manual' | 'webhook' | 'schedule' | 'api' | 'flow-invoker'>().notNull(),
    workerTag: text('worker_tag').notNull().default('default'),
    priority: integer('priority').notNull().default(0),
    parameters: jsonb('parameters'),
    input: jsonb('input'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    workerId: text('worker_id'),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    startRssBytes: bigint('start_rss_bytes', { mode: 'number' }),
    peakRssBytes: bigint('peak_rss_bytes', { mode: 'number' }),
    cpuMs: bigint('cpu_ms', { mode: 'number' }),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    record: jsonb('record'),
    definition: jsonb('definition'),
    progress: jsonb('progress'),
    runFrom: jsonb('run_from'),
    scripts: jsonb('scripts'),
    calledFlows: jsonb('called_flows'),
    rootId: uuid('root_id'),
    parentNodeId: text('parent_node_id'),
    callChain: jsonb('call_chain'),
    /** what the Runs page lists, in columns of its own: never read from record or definition there */
    flowName: text('flow_name'),
    startedBy: text('started_by'),
    parentNodeLabel: text('parent_node_label'),
    batchSize: integer('batch_size'),
    error: text('error'),
    envelopesIn: bigint('envelopes_in', { mode: 'number' }),
    envelopesOut: bigint('envelopes_out', { mode: 'number' }),
    rerunOf: uuid('rerun_of'),
    scheduleId: uuid('schedule_id'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    webhookId: uuid('webhook_id'),
});

export const runs = pgTable('runs', runColumns());

/** The editor's test runs (validation): the same columns, only the latest per flow and user, none older than a day. */
export const testRuns = pgTable('test_runs', { ...runColumns(), userId: text('user_id').notNull() });

/** the two tables a run may be in; a run id is in one of them only */
export const RUN_TABLES = ['test_runs', 'runs'] as const;
export type RunTable = (typeof RUN_TABLES)[number];

/** skipped: a schedule's time while its previous run was still going (never queued) */
export type RunRowStatus = 'queued' | 'running' | 'completed' | 'with-warnings' | 'with-errors' | 'failed' | 'cancelled' | 'skipped';

export type Run = typeof runs.$inferSelect;
