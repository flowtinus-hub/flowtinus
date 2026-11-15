import { z } from 'zod';
import type { Database } from '#shared/database/database';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { and, eq, sql } from 'drizzle-orm';
import { workspaces } from '#features/workspaces/workspace';
import { runs, type RunRowStatus } from '../run';

/*
 * The Runs page (GET /runs, /runs/overview, /runs/:id/tree): the runs for real of the user's workspaces (the runs table: test
 * runs are the editor's), each top run with the tree of the runs it queued (fire and forget). Only the columns of
 * the list (and the times): never record, progress or definition (big jsonb).
 */

export type RunListItem = {
    id: string;
    status: RunRowStatus;
    trigger: string;
    workspaceSlug: string;
    workspaceName: string;
    projectId: string | null;
    projectName: string | null;
    flowId: string;
    flowName: string | null;
    startedBy: string | null;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    envelopesIn: number | null;
    envelopesOut: number | null;
    error: string | null;
    workerId: string | null;
    parentId: string | null;
    rootId: string | null;
    calledBy: string | null;
    batchSize: number | null;
    version: number | null;
    rerunOf: string | null;
};

export const TREE_LIMIT = 200;

const SELECT = `
  SELECT r.id, r.status, r.trigger, r.project_id AS "projectId", p.name AS "projectName", r.flow_id AS "flowId",
         r.flow_name AS "flowName", coalesce(u.name, r.started_by) AS "startedBy", r.queued_at AS "queuedAt",
         r.started_at AS "startedAt", r.finished_at AS "finishedAt", r.duration_ms AS "durationMs",
         r.envelopes_in AS "envelopesIn", r.envelopes_out AS "envelopesOut", r.error, r.worker_id AS "workerId",
         r.parent_id AS "parentId", r.root_id AS "rootId", r.parent_node_label AS "calledBy", r.batch_size AS "batchSize",
         fv.number AS version, r.rerun_of AS "rerunOf", w.slug AS "workspaceSlug", w.name AS "workspaceName"
  FROM runs r
  JOIN workspaces w ON w.id = r.workspace_id
  LEFT JOIN flow_versions fv ON fv.id = r.flow_version_id
  LEFT JOIN projects p ON p.id = r.project_id
  LEFT JOIN users u ON u.id::text = r.started_by`;

type Row = Omit<RunListItem, 'queuedAt' | 'startedAt' | 'finishedAt' | 'durationMs' | 'envelopesIn' | 'envelopesOut' | 'batchSize'> & {
    queuedAt: Date | string;
    startedAt: Date | string | null;
    finishedAt: Date | string | null;
    durationMs: number | string | null;
    envelopesIn: number | string | null;
    envelopesOut: number | string | null;
    batchSize: number | string | null;
};

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
const num = (v: number | string | null) => (v === null ? null : Number(v));
const item = (r: Row): RunListItem => ({
    ...r,
    queuedAt: iso(r.queuedAt)!,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    durationMs: num(r.durationMs),
    envelopesIn: num(r.envelopesIn),
    envelopesOut: num(r.envelopesOut),
    batchSize: num(r.batchSize),
});

async function treesOf(
    db: Database,
    workspaceIds: string[],
    rootIds: string[],
): Promise<{ runs: RunListItem[]; sizes: Map<string, number> }> {
    if (rootIds.length === 0) {
        return { runs: [], sizes: new Map() };
    }

    const rows = await db.query<Row & { n: number | string; total: number | string }>(
        `SELECT * FROM (
       ${SELECT.replace('SELECT r.id', 'SELECT row_number() OVER (PARTITION BY r.root_id ORDER BY r.queued_at, r.id) AS n, count(*) OVER (PARTITION BY r.root_id) AS total, r.id')}
       WHERE r.workspace_id = ANY($1::uuid[]) AND r.root_id = ANY($2::uuid[])
     ) t WHERE n <= $3 ORDER BY "queuedAt", id`,
        [workspaceIds, rootIds, TREE_LIMIT],
    );
    const sizes = new Map<string, number>();
    for (const row of rows) {
        sizes.set(row.rootId!, Number(row.total));
    }
    return { runs: rows.map(({ n: _n, total: _total, ...row }) => item(row)), sizes };
}

async function readableWorkspaces(ctx: UseCaseContext, slug: string | undefined): Promise<string[]> {
    const ids = ctx.workspaceIds ?? [ctx.workspaceId];
    if (!slug) {
        return ids;
    }

    const [row] = await ctx.db.orm.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug));
    return row && ids.includes(row.id) ? [row.id] : [];
}

export const STATUS_FILTER = ['all', 'open', 'running', 'queued', 'problems', 'completed', 'cancelled'] as const;
export type RunStatusFilter = (typeof STATUS_FILTER)[number];

export function statusCondition(status: RunStatusFilter, param: (value: unknown) => string): string | null {
    if (status === 'open') {
        return `x.status IN ('queued', 'running')`;
    }
    if (status === 'problems') {
        return `x.status IN ('failed', 'with-errors')`;
    }
    return status === 'all' ? null : `x.status = ${param(status)}`;
}

const Period = z.enum(['24h', '7d']);
export const RUN_PERIODS: Record<z.infer<typeof Period>, string> = { '24h': '1 day', '7d': '7 days' };

export const ListRunsQuery = z.object({
    status: z.enum(STATUS_FILTER).default('all'),
    workspace: z.string().trim().optional(),
    project: z.uuid('Invalid').optional(),
    flow: z.uuid('Invalid').optional(),
    trigger: z.enum(['manual', 'schedule', 'webhook', 'api', 'flow-invoker']).optional(),
    q: z.string().trim().max(200).optional(),
    period: Period.optional(),
    before: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type RunListPage = {
    runs: RunListItem[];
    treeSizes: Record<string, number>;
    next: string | null;
};

/**
 * The top runs (queued by no other run) of the user's workspaces (or one of them), newest first, a page at a time, each with its tree. A
 * filter (status, project, trigger, search) keeps a top run when it or a run of its tree fits: a run that completed
 * while one it queued still runs shows under "running".
 */
export class ListRunsHandler implements UseCaseHandler<RunListPage> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<RunListPage>> {
        const parsed = validate(ListRunsQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { workspace, status, project, flow, trigger, q, period, before, limit } = parsed.value;
        const ids = await readableWorkspaces(ctx, workspace);
        const values: unknown[] = [ids];
        const param = (value: unknown) => {
            values.push(value);
            return `$${values.length}`;
        };
        const fits: string[] = [];
        const byStatus = statusCondition(status, param);
        if (byStatus) {
            fits.push(byStatus);
        }
        if (project) {
            fits.push(`x.project_id = ${param(project)}`);
        }
        if (flow) {
            fits.push(`x.flow_id = ${param(flow)}`);
        }
        if (trigger) {
            fits.push(`x.trigger = ${param(trigger)}`);
        }
        if (q) {
            const term = param(q.toLowerCase());
            fits.push(`(x.id::text LIKE ${term} || '%' OR lower(x.flow_name) LIKE '%' || ${term} || '%')`);
        }

        const where = ['r.workspace_id = ANY($1::uuid[])', 'r.parent_id IS NULL'];
        if (period) {
            where.push(`r.queued_at > now() - ${param(RUN_PERIODS[period])}::interval`);
        }
        if (fits.length) {
            const one = fits.join(' AND ');
            where.push(`(${one.replaceAll('x.', 'r.')} OR EXISTS (SELECT 1 FROM runs x WHERE x.root_id = r.id AND ${one}))`);
        }

        if (before) {
            const [at, id] = before.split('|');
            if (!at || !id || Number.isNaN(Date.parse(at))) {
                return fail('validation', 'Invalid page.');
            }

            where.push(`(r.queued_at, r.id) < (${param(at)}::timestamptz, ${param(id)}::uuid)`);
        }

        const roots = (
            await ctx.db.query<Row>(
                `${SELECT} WHERE ${where.join(' AND ')} ORDER BY r.queued_at DESC, r.id DESC LIMIT ${param(limit + 1)}`,
                values,
            )
        ).map(item);
        const page = roots.slice(0, limit);
        const last = page[page.length - 1];
        const trees = await treesOf(
            ctx.db,
            ids,
            page.map(r => r.id),
        );
        return success({
            runs: [...page, ...trees.runs],
            treeSizes: Object.fromEntries(page.map(r => [r.id, trees.sizes.get(r.id) ?? 0])),
            next: roots.length > limit && last ? `${last.queuedAt}|${last.id}` : null,
        });
    }
}

export const RunOverviewQuery = z.object({ period: Period.default('24h'), workspace: z.string().trim().optional() });

/**
 * The numbers above the list. Every one counts runs, the ones a Flow Invoker queued (fire and forget) too; `top` is how
 * many of `all` are top runs (the list's rows). The period's ones are the runs queued in it, so none goes past `all`.
 */
export type RunOverview = {
    all: number;
    top: number;
    running: number;
    inFlight: number;
    queued: number;
    oldestWaitMs: number;
    problems: number;
    completed: number;
};

export class RunOverviewHandler implements UseCaseHandler<RunOverview> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<RunOverview>> {
        const parsed = validate(RunOverviewQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const ids = await readableWorkspaces(ctx, parsed.value.workspace);

        const [open] = await ctx.db.query<{
            running: number | string;
            queued: number | string;
            inFlight: number | string | null;
            oldest: Date | string | null;
        }>(
            `SELECT count(*) FILTER (WHERE status = 'running') AS running, count(*) FILTER (WHERE status = 'queued') AS queued,
              sum(envelopes_in) FILTER (WHERE status = 'running') AS "inFlight", min(queued_at) FILTER (WHERE status = 'queued') AS oldest
       FROM runs WHERE workspace_id = ANY($1::uuid[]) AND status IN ('queued', 'running')`,
            [ids],
        );
        const [day] = await ctx.db.query<{
            all: number | string;
            top: number | string;
            problems: number | string;
            completed: number | string;
        }>(
            `SELECT count(*) AS all, count(*) FILTER (WHERE parent_id IS NULL) AS top,
              count(*) FILTER (WHERE status IN ('failed', 'with-errors')) AS problems, count(*) FILTER (WHERE status = 'completed') AS completed
       FROM runs WHERE workspace_id = ANY($1::uuid[]) AND queued_at > now() - $2::interval`,
            [ids, RUN_PERIODS[parsed.value.period]],
        );
        return success({
            all: Number(day?.all ?? 0),
            top: Number(day?.top ?? 0),
            running: Number(open?.running ?? 0),
            inFlight: Number(open?.inFlight ?? 0),
            queued: Number(open?.queued ?? 0),
            oldestWaitMs: open?.oldest ? Math.max(0, Date.now() - new Date(open.oldest).getTime()) : 0,
            problems: Number(day?.problems ?? 0),
            completed: Number(day?.completed ?? 0),
        });
    }
}

export const RunTreeQuery = z.object({ id: z.uuid('Invalid') });

export class RunTreeHandler implements UseCaseHandler<Omit<RunListPage, 'next'>> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<Omit<RunListPage, 'next'>>> {
        const parsed = validate(RunTreeQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const [found] = await ctx.db.orm
            .select({ root: sql<string>`coalesce(${runs.rootId}, ${runs.id})` })
            .from(runs)
            .where(and(eq(runs.id, parsed.value.id), eq(runs.workspaceId, ctx.workspaceId)));
        if (!found) {
            return fail('not-found', 'Run not found.');
        }

        const [root] = (await ctx.db.query<Row>(`${SELECT} WHERE r.id = $1 AND r.workspace_id = $2`, [found.root, ctx.workspaceId])).map(
            item,
        );
        if (!root) {
            return fail('not-found', 'Run not found.');
        }

        const tree = await treesOf(ctx.db, [ctx.workspaceId], [root.id]);
        return success({ runs: [root, ...tree.runs], treeSizes: { [root.id]: tree.sizes.get(root.id) ?? 0 } });
    }
}
