/*
 * What a project holds: folders, nested to any depth, and flows, at the root or in a folder (flows-api.ts loads and
 * changes them on flowtinus.server). Folders only arrange the flows: a flow keeps its id when it moves or is renamed.
 * A flow has only a name: the project's icon and color stand for its flows.
 */

import type { EmergencyRollback } from '@/data/deployments/deployment';

export { NAME_MAX, validateName } from '@flowtinus/core';

export type Folder = {
    id: string;
    projectId: string;
    /** null = at the project's root */
    parentId: string | null;
    name: string;
    createdAt: Date;
    /** when it was archived (with everything under it); null while it is active */
    archivedAt: Date | null;
};

export type Flow = {
    id: string;
    projectId: string;
    /** null = at the project's root */
    folderId: string | null;
    name: string;
    /** which supervisors run it (theirs in WORKER_TAGS): its runs and test runs */
    workerTag: string;
    createdAt: Date;
    updatedAt: Date;
    updatedBy: string;
    /** who that is, by name (the server's users), when known */
    updatedByName?: string;
    /** when it was archived; null while it is active */
    archivedAt: Date | null;
    readOnly?: boolean;
    removedBranch?: boolean;
    workBranch?: boolean;
    offersBranch?: boolean;
    /** the number of its deployed version in this environment: null when not deployed (known in the project's lists) */
    deployedVersion?: number | null;
    /** with git on: deployedVersion runs here instead of git's version (known in the project's lists) */
    emergencyRollback?: Pick<EmergencyRollback, 'number' | 'gitNumber' | 'byName'>;
    /** how many schedules it has, and how many are on (known in the project's lists; null: none) */
    schedules?: { total: number; on: number } | null;
    /** how many webhooks it has, and how many are on (known in the project's lists; null: none) */
    webhooks?: { total: number; on: number } | null;
};

export type FlowStatus = 'active' | 'archived';

/** everything a project holds, archived included (project-tree.ts says what is visible) */
export type ProjectContents = { folders: Folder[]; flows: Flow[] };
