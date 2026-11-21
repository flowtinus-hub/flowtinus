import { z } from 'zod';
import { ListRunsHandler, STATUS_FILTER, type RunListItem } from '#features/runs/list-runs/list-runs-handler';
import { ListTestRunsHandler, type TestRunListItem } from '#features/runs/list-runs/list-test-runs-handler';
import { defineTool, failed, ok, type ToolContext } from './tool';

/*
 * list_runs: the runs of a workspace or of one flow, newest first, both kinds: the runs for real (the Runs page's list,
 * ListRunsHandler: kept with their history, each top run with the runs it queued, fire and forget) and the user's test
 * runs (test_runs keeps only the latest full one and the latest Run from here per flow and user, for a day). One page
 * takes `limit` top runs of both, merged by the time they were queued; `cursor` continues where it ended.
 */

type ListedRun = {
    runId: string;
    mode: 'execution' | 'validation';
    status: string;
    flowId: string;
    flowName: string | null;
    trigger?: string;
    queuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    envelopesIn: number | null;
    envelopesOut: number | null;
    error?: string;
    parentId?: string;
    rootId?: string;
    /** the deployed version it ran (none: the draft) */
    version?: number;
    fromNodeId?: string;
    editorUrl?: string;
};

const real = (r: RunListItem, t: ToolContext): ListedRun => ({
    runId: r.id,
    mode: 'execution',
    status: r.status,
    flowId: r.flowId,
    flowName: r.flowName,
    trigger: r.trigger,
    queuedAt: r.queuedAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    envelopesIn: r.envelopesIn,
    envelopesOut: r.envelopesOut,
    ...(r.error ? { error: r.error } : {}),
    ...(r.parentId ? { parentId: r.parentId } : {}),
    ...(r.rootId && r.rootId !== r.id ? { rootId: r.rootId } : {}),
    ...(r.version !== null ? { version: r.version } : {}),
    ...(t.runLink(r.id) ? { editorUrl: t.runLink(r.id) } : {}),
});

const test = (r: TestRunListItem, t: ToolContext): ListedRun => ({
    runId: r.id,
    mode: 'validation',
    status: r.status,
    flowId: r.flowId,
    flowName: r.flowName,
    queuedAt: r.queuedAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    envelopesIn: r.envelopesIn,
    envelopesOut: r.envelopesOut,
    ...(r.error ? { error: r.error } : {}),
    ...(r.fromNodeId ? { fromNodeId: r.fromNodeId } : {}),
    ...(t.runLink(r.id) ? { editorUrl: t.runLink(r.id) } : {}),
});

export const listRuns = defineTool({
    name: 'list_runs',
    scope: 'runs:read',
    description:
        "The runs of a workspace or of one flow, newest first: for real (Run for real, schedules, webhooks; kept with their history, with the runs they queued, fire and forget, under them: parentId, rootId) and your own test runs (test_run, the editor's Run: only the latest full one and the latest Run from here per flow, for a day). Filter by status (open = queued or running, problems = failed or with errors) and mode. A page is `limit` top runs; `next` is the cursor of the following page. Read one with get_run.",
    input: {
        workspace: z.string().optional().describe("the workspace's handle (list_workspaces), when no flowId names it"),
        flowId: z.string().optional().describe('only the runs of this flow'),
        status: z.enum(STATUS_FILTER).default('all').describe('which runs'),
        mode: z
            .enum(['execution', 'validation'])
            .optional()
            .describe('execution: only runs for real; validation: only test runs; none: both'),
        limit: z.number().int().min(1).max(50).default(20).describe('top runs per page'),
        cursor: z.string().optional().describe('`next` of the page before'),
    },
    run: async ({ workspace, flowId, status, mode, limit, cursor }, t) => {
        if (!workspace && !flowId) {
            return failed({ code: 'validation', message: 'Name a workspace (its handle) or a flowId.' });
        }
        const flow = flowId ? { flow: flowId } : {};
        const before = cursor ? { before: cursor } : {};
        const groups: { top: { queuedAt: string; id: string }; runs: ListedRun[] }[] = [];
        let more = false;
        if (mode !== 'validation') {
            const page = await new ListRunsHandler().handle({ status, limit, ...flow, ...before }, t.ctx);
            if (!page.ok) {
                return failed(page.error);
            }
            for (const top of page.value.runs.filter(r => !r.parentId)) {
                const tree = page.value.runs.filter(r => r.id === top.id || r.rootId === top.id);
                const runs = tree.filter(r => !flowId || r.flowId === flowId).map(r => real(r, t));
                groups.push({ top: { queuedAt: top.queuedAt, id: top.id }, runs });
            }
            more ||= page.value.next !== null;
        }
        if (mode !== 'execution') {
            const page = await new ListTestRunsHandler().handle({ status, limit, ...flow, ...before }, t.ctx);
            if (!page.ok) {
                return failed(page.error);
            }
            groups.push(...page.value.runs.map(r => ({ top: { queuedAt: r.queuedAt, id: r.id }, runs: [test(r, t)] })));
            more ||= page.value.next !== null;
        }
        groups.sort((a, b) => b.top.queuedAt.localeCompare(a.top.queuedAt) || b.top.id.localeCompare(a.top.id));
        const page = groups.slice(0, limit);
        const last = page.at(-1)?.top;
        return ok({
            runs: page.flatMap(g => g.runs),
            next: last && (more || groups.length > limit) ? `${last.queuedAt}|${last.id}` : null,
        });
    },
});
