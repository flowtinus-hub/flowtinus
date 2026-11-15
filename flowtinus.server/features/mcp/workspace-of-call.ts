import type { WorkspaceRole } from '#features/workspaces/workspace-member';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import type { UseCaseError } from '#shared/use-cases/use-case-result';

/*
 * A token is its user's and reaches all the user's workspaces: each MCP call acts in one of them, the one it names
 * (`workspace`, a slug) or the one of the flow, project, run or connection it names (ids are unique in the environment). The user
 * must be a member of it; what they may do there is their role in it (and the token's scopes).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CallWorkspace = { ctx: UseCaseContext; slug: string };

type Args = { workspace?: unknown; flowId?: unknown; projectId?: unknown; runId?: unknown; connectionId?: unknown };

const SOURCES: { key: keyof Args; what: string; sql: string }[] = [
    { key: 'workspace', what: 'Workspace', sql: 'SELECT id FROM workspaces WHERE slug = $1' },
    { key: 'flowId', what: 'Flow', sql: 'SELECT workspace_id AS id FROM flows WHERE id = $1' },
    { key: 'projectId', what: 'Project', sql: 'SELECT workspace_id AS id FROM projects WHERE id = $1' },
    {
        key: 'runId',
        what: 'Run',
        sql: 'SELECT workspace_id AS id FROM runs WHERE id = $1 UNION ALL SELECT workspace_id FROM test_runs WHERE id = $1',
    },
    { key: 'connectionId', what: 'Connection', sql: 'SELECT workspace_id AS id FROM connections WHERE id = $1' },
];

export async function workspaceOfCall(
    ctx: UseCaseContext,
    args: Args,
): Promise<{ ok: true; value: CallWorkspace | null } | { ok: false; error: UseCaseError }> {
    const source = SOURCES.find(s => typeof args[s.key] === 'string' && args[s.key] !== '');
    if (!source) {
        return { ok: true, value: null };
    }

    const value = String(args[source.key]);
    if (source.key !== 'workspace' && !UUID.test(value)) {
        return { ok: true, value: null };
    }

    const [row] = await ctx.db.query<{ id: string; slug: string; role: WorkspaceRole }>(
        `SELECT w.id, w.slug, m.role
       FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id::text = $2
      WHERE w.deleted_at IS NULL AND w.id IN (${source.sql})`,
        [value, ctx.userId],
    );
    if (!row) {
        const hint = source.key === 'workspace' ? ' (list_workspaces gives them)' : '';
        return { ok: false, error: { code: 'not-found', message: `${source.what} not found in your workspaces${hint}.` } };
    }

    return { ok: true, value: { ctx: { ...ctx, workspaceId: row.id, role: row.role }, slug: row.slug } };
}
