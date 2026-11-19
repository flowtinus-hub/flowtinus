import { currentBranchView } from './current-branch';
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
import { isGitOn } from './git-config';
import { commitWorkingCopy, createBranch, discardWorkingCopy, workingChanges, type CreatedBranch, type WorkingChange } from './working-copy-changes';

const gitOff = () => fail('conflict', 'Git is off in this workspace.');

export class GetChangesHandler implements UseCaseHandler<{ changes: WorkingChange[] }> {
    async handle(_input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ changes: WorkingChange[] }>> {
        if (!(await isGitOn(ctx.db, ctx.workspaceId))) {
            return gitOff();
        }
        // on a pull-request server's environment branch the changes made before stay listed, to take to a branch
        const view = await currentBranchView(ctx.db, ctx.workspaceId, ctx.userId);
        return success({ changes: view.editable || view.offersBranch ? await workingChanges(ctx) : [] });
    }
}

export const CommitChangesCommand = z.object({
    paths: z.array(z.string().min(1)).min(1),
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
