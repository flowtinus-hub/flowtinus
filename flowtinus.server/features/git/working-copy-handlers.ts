import { z } from 'zod';
import { validateFlowFile } from '@flowtinus/core';
import { branchFlow, workBranch } from './branch-read';
import { saveDraftOnBranch } from './branch-edits';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { branchAccess, currentBranchView } from './current-branch';
import { isGitOn } from './git-config';
import { pendingMerge, pendingMergeView, type PendingMergeView } from './pending-merge';
import { updateBranch, updateStatus, type UpdateOutcome, type UpdateStatus } from './update';
import { readConflict, resolveConflict, type ConflictView } from './conflicts';
import { commitWorkingCopy, createBranch, discardWorkingCopy, workingChanges, type CreatedBranch, type WorkingChange } from './working-copy-changes';

const gitOff = () => fail('conflict', 'Git is off in this workspace.');

/** merge: a pending merge on the branch, which a Commit takes whole and Discard all aborts */
export type ChangesView = { changes: WorkingChange[]; merge?: PendingMergeView };

export class GetChangesHandler implements UseCaseHandler<ChangesView> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<ChangesView>> {
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return gitOff();
        }
        // listed to whoever may take them to a new branch or discard them (a removed branch), and on a pull-request
        // server's environment branch, where the changes made before stay, to take to a branch
        const [{ mayChange }, view] = await Promise.all([
            branchAccess(ctx.db, ctx.workspaceId, ctx.userId),
            currentBranchView(ctx.db, ctx.workspaceId, ctx.userId),
        ]);
        if (!mayChange && !view.offersBranch) {
            return success({ changes: [] });
        }
        const branch = await workBranch(ctx);
        const merge = branch && (await pendingMerge(ctx.db, ctx.workspaceId, branch.branch));
        return success({ changes: await workingChanges(ctx), ...(merge ? { merge: pendingMergeView(merge) } : {}) });
    }
}

export class GetUpdateHandler implements UseCaseHandler<UpdateStatus> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<UpdateStatus>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return gitOff();
        }
        return updateStatus(ctx);
    }
}

export class UpdateBranchHandler implements UseCaseHandler<UpdateOutcome> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<UpdateOutcome>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return gitOff();
        }
        return updateBranch(ctx);
    }
}

export const CommitChangesCommand = z.object({
    // empty: only for a pending merge, committed whole even when every file it brought was discarded
    paths: z.array(z.string().min(1)),
    message: z.string().trim().min(1).max(1000),
});

export class CommitChangesHandler implements UseCaseHandler<{ commit: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ commit: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(CommitChangesCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        const committed = await commitWorkingCopy(ctx, parsed.value);
        return committed.ok ? success({ commit: committed.value }) : committed;
    }
}

export const CreateBranchCommand = z.object({
    name: z.string().trim().min(1, 'Required'),
    /** the edit that offered the branch (a flow's draft on a pull-request server's environment branch), saved on it */
    draft: z.object({ flowId: z.uuid('Invalid'), flow: z.unknown() }).optional(),
});

/** draft: the edit taken along, saved on the new branch (its revision), or why it could not be */
export type CreatedBranchView = CreatedBranch & { draft?: { revision: number } | { error: string } };

export class CreateBranchHandler implements UseCaseHandler<CreatedBranchView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<CreatedBranchView>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(CreateBranchCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        const { name, draft } = parsed.value;
        const checked = draft ? validateFlowFile(draft.flow) : null;
        if (checked && !checked.ok) {
            return fail('validation', `The flow is not valid: ${checked.errors.join(' ')}`);
        }
        const created = await createBranch(ctx, name);
        if (!created.ok || !draft || !checked?.ok) {
            return created;
        }

        // a new context: the one of this request read the branch the user was on
        const on = { ...ctx };
        try {
            const branch = await workBranch(on);
            const flow = branch && branchFlow(branch, draft.flowId);
            if (!branch || !flow) {
                return success({ ...created.value, draft: { error: `The flow is not on ${name}: the edit was not taken along.` } });
            }
            const saved = await saveDraftOnBranch(on, branch, { id: flow.id, revision: flow.revision, flow: checked.value });
            return success({ ...created.value, draft: saved.ok ? { revision: saved.value.revision } : { error: saved.error.message } });
        } catch (e) {
            // the branch is made and current whatever happens to the edit
            if (e instanceof UseCaseFailure) {
                return success({ ...created.value, draft: { error: e.error.message } });
            }
            throw e;
        }
    }
}

export const DiscardChangesCommand = z.union([z.object({ paths: z.array(z.string().min(1)).min(1) }), z.object({ mine: z.literal(true) })]);

export class DiscardChangesHandler implements UseCaseHandler<{ discarded: string[] }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ discarded: string[] }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(DiscardChangesCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return gitOff();
        }
        return discardWorkingCopy(ctx, 'paths' in parsed.value ? { paths: parsed.value.paths } : 'mine');
    }
}

export class GetConflictHandler implements UseCaseHandler<ConflictView> {
    async handle(input: { path?: string }, ctx: UseCaseContext): Promise<UseCaseResult<ConflictView>> {
        const denied = requireRole(ctx, 'viewer');
        if (denied) {
            return denied;
        }
        if (!input.path) {
            return fail('validation', 'The request has invalid fields.', { path: 'Required' });
        }
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return gitOff();
        }
        return readConflict(ctx, input.path);
    }
}

const HunkChoiceSchema = z.union([z.enum(['mine', 'theirs', 'both']), z.object({ edit: z.string() })]);

export const ResolveConflictCommand = z.object({
    path: z.string().min(1),
    revision: z.number().int(),
    hunks: z.array(HunkChoiceSchema).optional(),
    name: z.enum(['mine', 'theirs']).optional(),
    keep: z.boolean().optional(),
    rename: z.string().optional(),
});

export class ResolveConflictHandler implements UseCaseHandler<{ path: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ path: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(ResolveConflictCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return gitOff();
        }
        return resolveConflict(ctx, parsed.value);
    }
}
