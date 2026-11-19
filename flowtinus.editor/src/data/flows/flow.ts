/*
 * What a project holds: folders, nested to any depth, and flows, at the root or in a folder (flows-api.ts loads and
 * changes them on flowtinus.server). Folders only arrange the flows: a flow keeps its id when it moves or is renamed.
 * A flow has only a name: the project's icon and color stand for its flows.
 */

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
    /** read from a branch the user cannot edit: it opens read only (it still runs) */
    readOnly?: boolean;
    /** read from a work branch removed on the remote: its changes go to a new branch or are discarded */
    removedBranch?: boolean;
    /** read from a work branch: deploy, schedules, webhooks and the worker tag are the environment's, not here */
    workBranch?: boolean;
    /** read from a pull-request server's environment branch: the first edit offers Create branch, which takes it along */
    offersBranch?: boolean;
    /** the number of its deployed version in this environment: null when not deployed (known in the project's lists) */
    deployedVersion?: number | null;
    /** how many schedules it has, and how many are on (known in the project's lists; null: none) */
    schedules?: { total: number; on: number } | null;
    /** how many webhooks it has, and how many are on (known in the project's lists; null: none) */
    webhooks?: { total: number; on: number } | null;
};

export type FlowStatus = 'active' | 'archived';

/** everything a project holds, archived included (project-tree.ts says what is visible) */
export type ProjectContents = { folders: Folder[]; flows: Flow[] };
