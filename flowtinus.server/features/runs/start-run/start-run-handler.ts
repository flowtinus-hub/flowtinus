import { z } from 'zod';
import { inputIssues, inputTypeRef, isFolderVisible, planRunFrom, scriptTypeShape, START, startConfig, toExecutableFlow, validateFlowFile, type FlowFile, type RunFromPlan, type RunRecord } from '@flowtinus/core';
import type { Database } from '#shared/database/database';
import { FlowRepository, loadTree } from '#features/folders/project-tree';
import { loadDraft } from '#features/flows/flow-draft';
import { pinsOf, withPins } from '#features/pins/pins';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { editingSource, typeSources, type ScriptSource } from '#features/scripts/script-store';
import { branchDraft, branchFlow, branchTree, workBranch } from '#features/git/branch-read';
import { ProjectRepository } from '#features/projects/project-repository';
import { CHANNELS, notifyRunEvent } from '../run-queue';
import { runSnapshot } from './run-snapshot';
import { hasLiveSupervisor, noSupervisorFor } from '#features/supervisors/supervisors';
import { runs, testRuns } from '../run';
import { inRunScope, type RunScope } from '#features/api-tokens/run-scope';

export const StartRunCommand = z.object({
    id: z.uuid('Invalid'),
    mode: z.enum(['validation', 'execution']),
    parameters: z.record(z.string(), z.string()).default({}),
    fromNodeId: z.string().min(1).optional(),
    fromLabel: z.string().trim().min(1).max(200).optional(),
    input: z.unknown().optional(),
});

export async function checkedInput(
    ctx: UseCaseContext,
    file: FlowFile,
    given: unknown,
    scripts: ScriptSource = 'editing',
): Promise<{ ok: true; input: unknown } | { ok: false; error: string }> {
    const startNode = file.nodes.find(n => n.type === START);
    const { acceptsInput, testInput } = startConfig(startNode?.config ?? {});
    if (given !== undefined && !acceptsInput) {
        return { ok: false, error: 'This flow does not take an input: turn on Accepts input in its Start.' };
    }

    let input = given;
    if (input === undefined && acceptsInput && testInput.trim()) {
        try {
            input = JSON.parse(testInput);
        } catch {
            return { ok: false, error: "The Start's default input is not valid JSON." };
        }
    }

    const typeRef = acceptsInput ? inputTypeRef(startNode?.config.inputType) : null;
    if (!typeRef || input === undefined) {
        return { ok: true, input };
    }

    const shape = scriptTypeShape(await typeSources(ctx.db, ctx.workspaceId, typeRef.path, scripts), typeRef.path, typeRef.name);
    if (!shape) {
        return { ok: false, error: `The Start's input type ${typeRef.name} no longer exists in the script ${typeRef.path}.` };
    }

    const issues = inputIssues(input, shape);
    return issues.length ? { ok: false, error: `The input does not fit ${typeRef.name}: ${issues.join(' ')}` } : { ok: true, input };
}

/**
 * The user's latest full test run of the flow (not a Run from here): Run from here takes from it what reached the
 * component (never from the client). Null while there is none, or while it still runs.
 */
async function lastFullTestRun(db: Database, workspaceId: string, flowId: string, userId: string): Promise<RunRecord | null> {
    const [test] = await db.query<{ record: RunRecord }>(
        `SELECT record FROM test_runs
     WHERE workspace_id = $1 AND flow_id = $2 AND user_id = $3 AND run_from IS NULL AND record IS NOT NULL AND status NOT IN ('queued', 'running')`,
        [workspaceId, flowId, userId],
    );
    return test?.record ?? null;
}

export class StartRunHandler implements UseCaseHandler<{ id: string }> {
    constructor(private readonly options: { runScope?: RunScope | null } = {}) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(StartRunCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { id: flowId, mode, parameters, fromNodeId, fromLabel, input: given } = parsed.value;
        if ((fromNodeId || fromLabel) && mode === 'execution') {
            return fail('validation', 'Run from here is a test run only: a run for real runs the whole flow.');
        }

        const branch = await workBranch(ctx);
        const row = branch ? branchFlow(branch, flowId) : await new FlowRepository(ctx.db, ctx.workspaceId).findById(flowId);
        const tree = row ? (branch ? branchTree(branch, row.projectId) : await loadTree(ctx.db, ctx.workspaceId, row.projectId)) : null;
        if (!row || !tree || !isFolderVisible(tree.folders, row.folderId)) {
            return fail('not-found', 'Flow not found.');
        }

        const scope = mode === 'execution' ? (this.options.runScope ?? null) : null;
        if (scope && !inRunScope(scope, row, tree.folders)) {
            return fail('forbidden', `The flow "${row.name}" is outside what this token may run for real.`);
        }

        // its tag: a run (test runs too) only goes to the queue while a live supervisor takes it, or it would wait forever
        if (!(await hasLiveSupervisor(ctx.db, row.workerTag))) {
            return fail('unavailable', noSupervisorFor(row.workerTag));
        }

        const draft = branch ? branchDraft(branchFlow(branch, flowId)!).flow : (await loadDraft(ctx.db, ctx.workspaceId, row)).flow;
        const scriptSource = editingSource(branch);
        const checked = validateFlowFile(
            mode === 'validation' ? withPins(draft, await pinsOf(ctx.db, ctx.workspaceId, ctx.userId, flowId)) : draft,
        );
        if (!checked.ok) {
            return fail('validation', `The flow cannot run: ${checked.errors.join(' ')}`);
        }

        const runInput = fromNodeId ? { ok: true as const, input: undefined } : await checkedInput(ctx, checked.value, given, scriptSource);
        if (!runInput.ok) {
            return fail('validation', runInput.error);
        }

        let runFrom: RunFromPlan | null = null;
        if (fromNodeId) {
            const last = await lastFullTestRun(ctx.db, ctx.workspaceId, flowId, ctx.userId);
            if (!last) {
                return fail('validation', 'Run the flow first: Run from here starts from what reached the component in the last test run.');
            }

            const planned = planRunFrom(toExecutableFlow(checked.value, ''), fromNodeId, last.components);
            if (!planned.ok) {
                return fail('validation', planned.error);
            }

            runFrom = { ...planned.plan, label: fromLabel ?? planned.plan.label };
        }

        const snapshot = await runSnapshot(ctx, tree, checked.value, 'draft', branch);
        if (!snapshot.ok) {
            return fail('validation', `The flow cannot run: ${snapshot.error}`);
        }

        const { scripts } = snapshot;
        const called = scope
            ? snapshot.calledFlows.map(c => {
                  const flow = tree.flows.find(f => f.id === c.id);
                  return c.unavailable || (flow && inRunScope(scope, flow, tree.folders))
                      ? c
                      : { ...c, unavailable: 'it is outside what the token that started this run may run for real (its run scope).' };
              })
            : mode === 'validation'
              ? await Promise.all(
                    snapshot.calledFlows.map(async c =>
                        c.flow ? { ...c, flow: withPins(c.flow, await pinsOf(ctx.db, ctx.workspaceId, ctx.userId, c.id)) } : c,
                    ),
                )
              : snapshot.calledFlows;
        const id = crypto.randomUUID();
        const draftHash = new Bun.CryptoHasher('sha256').update(JSON.stringify(checked.value)).digest('hex');
        const values = {
            id,
            workspaceId: ctx.workspaceId,
            flowId,
            mode,
            draftHash,
            // a project only on a branch has no row for the run to name
            projectId: branch && !(await new ProjectRepository(ctx.db, ctx.workspaceId).findById(row.projectId)) ? null : row.projectId,
            status: 'queued' as const,
            trigger: 'manual' as const,
            workerTag: row.workerTag,
            parameters,
            definition: checked.value,
            runFrom,
            scripts,
            calledFlows: called.length ? called : null,
            flowName: row.name,
            startedBy: ctx.userId,
            ...(given !== undefined ? { input: given } : {}),
        };
        if (mode === 'execution') {
            await ctx.db.orm.insert(runs).values(values);
        } else {
            const replaced = await ctx.db.transaction(async tx => {
                // one at a time per flow and user (two clicks at once)
                await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`test-run:${ctx.workspaceId}:${flowId}:${ctx.userId}`]);
                // a full run replaces both; a Run from here only the previous Run from here
                const old = await tx.query<{ id: string; status: string }>(
                    `DELETE FROM test_runs WHERE workspace_id = $1 AND flow_id = $2 AND user_id = $3 ${runFrom ? 'AND run_from IS NOT NULL' : ''} RETURNING id, status`,
                    [ctx.workspaceId, flowId, ctx.userId],
                );
                await tx.orm.insert(testRuns).values({ ...values, userId: ctx.userId });
                return old;
            });
            for (const old of replaced) {
                // still running: its supervisor stops it (its end is not stored: the row is gone); its followers are told
                if (old.status === 'running') {
                    await ctx.db.notify(CHANNELS.cancel, old.id);
                }

                await notifyRunEvent(ctx.db, { id: old.id, type: 'done' });
            }
        }

        await notifyRunEvent(ctx.db, { id, type: 'status', workspaceId: ctx.workspaceId, rootId: id, status: 'queued' });
        await ctx.db.notify(CHANNELS.queued, row.workerTag);
        return success({ id });
    }
}
