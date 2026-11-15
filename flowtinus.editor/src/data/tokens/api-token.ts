import type { Flow, Folder, ProjectContents } from '@/data/flows/flow';
import { folderPath } from '@/data/flows/project-tree';

/*
 * The user's personal access tokens (the Access tokens page): what an agent sends to the MCP (/mcp). A token is its
 * user's, not a workspace's: it reaches the user's workspaces, by role there, within its scopes. Its value is shown once,
 * when it is made. Its run scope holds runs:execute (Run for real) to some folders (with their subfolders) and flows.
 */

/** a scope a token may have, and what it allows (the server's list) */
export type ScopeInfo = { scope: string; description: string };

/** a folder or a flow of a run scope, as the server names it */
export type RunScopeItem = {
    id: string;
    path: string;
    project: string | null;
    workspace: string | null;
    /** archived, gone, or of a workspace the user is no longer in */
    unavailable?: true;
};

export type ApiToken = {
    id: string;
    name: string;
    /** its first characters (ftn_ and 8 more) */
    prefix: string;
    scopes: string[];
    /** null: any flow, each run with the user's approval */
    runScope: { folders: RunScopeItem[]; flows: RunScopeItem[] } | null;
    createdAt: Date;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
};

/** what a new token is made of; `runScope` only with runs:execute */
export type NewApiToken = {
    name: string;
    scopes: string[];
    runScope?: { folders: string[]; flows: string[] } | null;
    expiresInDays?: number | null;
};

/** the scope a run scope holds to some folders and flows */
export const RUN_FOR_REAL = 'runs:execute';

/** how long a new token lasts */
export const EXPIRY_OPTIONS: { days: number | null; label: string }[] = [
    { days: null, label: 'No expiration' },
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
    { days: 365, label: '1 year' },
];

/** a picked folder or flow of the run scope being made, with what the picker shows of it */
export type PickedItem = { kind: 'folder' | 'flow'; id: string; path: string; project: string; workspace: string };

/** a folder's path in its project (DW / Load) */
const pathOf = (folders: Folder[], id: string | null) =>
    id === null
        ? ''
        : folderPath(folders, id)
              .map(f => f.name)
              .join(' / ');

/** a folder or a flow of a project as the run scope picks it, named by its path */
export function pickedOf(
    kind: 'folder' | 'flow',
    item: Folder | Flow,
    contents: ProjectContents,
    project: string,
    workspace: string,
): PickedItem {
    const path =
        kind === 'folder'
            ? pathOf(contents.folders, item.id)
            : [pathOf(contents.folders, (item as Flow).folderId), item.name].filter(Boolean).join(' / ');
    return { kind, id: item.id, path, project, workspace };
}

/** what is wrong with a new token, per field (the server checks the same) */
export function validateNewToken(fields: {
    name: string;
    scopes: string[];
    limited: boolean;
    picked: PickedItem[];
}): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!fields.name.trim()) {
        errors.name = 'Required';
    } else if (fields.name.trim().length > 100) {
        errors.name = 'At most 100 characters';
    }
    if (fields.scopes.length === 0) {
        errors.scopes = 'Pick at least one scope';
    }
    if (fields.scopes.includes(RUN_FOR_REAL) && fields.limited && fields.picked.length === 0) {
        errors.runScope = 'Pick at least one folder or flow';
    }
    return errors;
}

/** the new token as the server takes it: a run scope only when runs:execute is held to some folders and flows */
export function newTokenOf(fields: {
    name: string;
    scopes: string[];
    limited: boolean;
    picked: PickedItem[];
    expiresInDays: number | null;
}): NewApiToken {
    const limited = fields.scopes.includes(RUN_FOR_REAL) && fields.limited;
    return {
        name: fields.name.trim(),
        scopes: fields.scopes,
        runScope: limited
            ? {
                  folders: fields.picked.filter(p => p.kind === 'folder').map(p => p.id),
                  flows: fields.picked.filter(p => p.kind === 'flow').map(p => p.id),
              }
            : null,
        expiresInDays: fields.expiresInDays,
    };
}

/** a token's run for real, in a few words: none, any flow, or how many folders and flows */
export function runForRealText(token: Pick<ApiToken, 'scopes' | 'runScope'>): string {
    if (!token.scopes.includes(RUN_FOR_REAL)) {
        return 'No run for real';
    }
    if (!token.runScope) {
        return 'Any flow, with approval';
    }
    const { folders, flows } = token.runScope;
    const parts = [
        folders.length ? `${folders.length} folder${folders.length === 1 ? '' : 's'}` : '',
        flows.length ? `${flows.length} flow${flows.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return parts.join(', ') || 'Nothing';
}

/** whether a token is past its expiration */
export const isExpired = (token: Pick<ApiToken, 'expiresAt'>, now = new Date()) => token.expiresAt !== null && token.expiresAt <= now;

/** a list with the item added, or taken out when it is there */
export const toggled = <T>(list: T[], item: T): T[] => (list.includes(item) ? list.filter(x => x !== item) : [...list, item]);
