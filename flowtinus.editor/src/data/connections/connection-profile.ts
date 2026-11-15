import type { ConnectionServer, ConnectionTypeName } from '@flowtinus/core';

/*
 * A connection profile: a reusable connection (database, API, storage, messaging) of a workspace, used by the flows of its projects.
 * Its config holds the fields of its type; sensitive values are names of the workspace's secrets. The rules
 * (validateProfile) are @flowtinus/core's, the same the server enforces.
 */

export { NAME_MAX, validateProfile, type ProfileFields } from '@flowtinus/core';

export type ConnectionProfile = {
    id: string;
    name: string;
    type: ConnectionTypeName;
    config: Record<string, string>;
    createdAt: Date;
    updatedAt: Date;
    updatedBy: string;
    /** who that is, by name (the server's users), when known */
    updatedByName?: string;
    /** a database's server as its last successful test found it (engine, version, when); none before one */
    server?: ConnectionServer | null;
};
