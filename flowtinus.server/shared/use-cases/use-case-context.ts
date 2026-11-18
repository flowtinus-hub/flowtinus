import type { Keyring } from '#shared/crypto/keyring';
import type { Database } from '#shared/database/database';
import type { WorkspaceRole } from '#features/workspaces/workspace-member';
import type { GitOptions } from '#features/git/git-config';

/**
 * Who is asking and where. Every handler gets it, so every repository can filter by workspaceId: a use case never
 * reads or writes another workspace's rows.
 */
export type UseCaseContext = {
    workspaceId: string;
    userId: string;
    role?: WorkspaceRole;
    workspaceIds?: string[];
    db: Database;
    keyring?: Keyring;
    git?: GitOptions;
};
