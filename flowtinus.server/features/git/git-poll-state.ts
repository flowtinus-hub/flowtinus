import type { Database } from '#shared/database/database';
import { readWorkspaceSetting, writeWorkspaceSetting } from '#features/workspaces/workspace-settings';
import { POLL_SETTING } from './git-config';

/** the last fetch of a workspace's branch: when, why it could not reconcile, and since when it has not been able to */
export type LastPoll = { at: string; error?: string; since?: string };

export const readLastPoll = async (db: Database, workspaceId: string) =>
    (await readWorkspaceSetting(db, workspaceId, POLL_SETTING)) as LastPoll | null;

/** a fetch done (by polling, the webhook or Reconcile now): an error keeps the time the errors began */
export async function recordPoll(db: Database, workspaceId: string, at: Date, error?: string): Promise<void> {
    const before = error ? await readLastPoll(db, workspaceId) : null;
    const since = before?.error ? (before.since ?? before.at) : at.toISOString();
    const poll: LastPoll = { at: at.toISOString(), ...(error ? { error, since } : {}) };
    await writeWorkspaceSetting(db, workspaceId, POLL_SETTING, poll, 'git');
}
