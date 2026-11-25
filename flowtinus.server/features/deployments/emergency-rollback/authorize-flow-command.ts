import type { z } from 'zod';
import type { Flow } from '#features/flows/flow';
import { gitBranch } from '#features/git/git-config';
import type { Mode } from '#features/git/topology';
import type { WorkspaceRole } from '#features/workspaces/workspace-member';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { activeFlow } from '../deployments';

export type FlowAccess = { role: (mode: Mode) => WorkspaceRole; gitOff: string };

// the mode is the last reconcile's, so that it works while git cannot be reached
export async function authorizeFlowCommand<T extends { id: string }>(
    input: unknown,
    schema: z.ZodType<T>,
    ctx: UseCaseContext,
    access: FlowAccess,
): Promise<UseCaseResult<{ flow: Flow; command: T; mode: Mode }>> {
    const denied = requireRole(ctx, 'editor');
    if (denied) {
        return denied;
    }

    const parsed = validate(schema, input);
    if (!parsed.ok) {
        return parsed;
    }

    const git = await gitBranch(ctx.db, ctx.workspaceId);
    if (!git) {
        return fail('conflict', access.gitOff);
    }

    const role = requireRole(ctx, access.role(git.mode));
    if (role) {
        return role;
    }

    const flow = await activeFlow(ctx, parsed.value.id);
    return flow ? success({ flow, command: parsed.value, mode: git.mode }) : fail('not-found', 'Flow not found.');
}
