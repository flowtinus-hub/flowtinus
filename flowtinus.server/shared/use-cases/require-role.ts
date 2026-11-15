import { roleAtLeast, type WorkspaceRole } from '#features/workspaces/workspace-member';
import type { UseCaseContext } from './use-case-context';
import { fail, type UseCaseResult } from './use-case-result';

const WHAT: Record<WorkspaceRole, string> = {
    viewer: 'a member of this workspace',
    editor: 'an editor or an admin of this workspace',
    admin: 'an admin of this workspace',
};

/** Checked in the handler, not the route: the MCP calls the handlers too. */
export function requireRole(ctx: UseCaseContext, required: WorkspaceRole): UseCaseResult<never> | null {
    return roleAtLeast(ctx.role, required) ? null : fail('forbidden', `Only ${WHAT[required]} can do this.`);
}
