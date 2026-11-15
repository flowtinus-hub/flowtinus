import { isFolderVisible, subtreeIds } from '@flowtinus/core';
import type { Flow, Folder, ProjectContents } from './flow';

/*
 * The rules of a project's folders and flows come from @flowtinus/core (folder-tree), the same the server enforces, so
 * the screens show an error as you type and the server answers the same. Here only what the screens add.
 */

export { byName, canMoveFolder, childrenOf, folderPath, isFolderVisible, itemCount, siblingNames, subtreeIds } from '@flowtinus/core';

/**
 * The Archived list: what was archived on its own or at the top of an archived folder, last archived first. What went
 * with a folder (archived at the same moment, inside it) is not listed apart: restoring the folder brings it back.
 */
export function archivedItems(contents: ProjectContents): ({ kind: 'folder'; item: Folder } | { kind: 'flow'; item: Flow })[] {
    const sameMoment = (a: Date | null, b: Date | null) => a !== null && b !== null && a.getTime() === b.getTime();
    const parentArchivedWith = (parentId: string | null, archivedAt: Date | null) => {
        const parent = contents.folders.find(f => f.id === parentId);
        return parent !== undefined && sameMoment(parent.archivedAt, archivedAt);
    };

    const items = [
        ...contents.folders
            .filter(f => f.archivedAt !== null && !parentArchivedWith(f.parentId, f.archivedAt))
            .map(item => ({ kind: 'folder' as const, item })),
        ...contents.flows
            .filter(f => f.archivedAt !== null && !parentArchivedWith(f.folderId, f.archivedAt))
            .map(item => ({ kind: 'flow' as const, item })),
    ];

    return items.sort((a, b) => b.item.archivedAt!.getTime() - a.item.archivedAt!.getTime());
}

/** a flow is visible when it is active and its folder (and every folder above) is too */
export const isFlowVisible = (folders: Folder[], flow: Flow) => flow.archivedAt === null && isFolderVisible(folders, flow.folderId);

/**
 * The flows an archive or a delete takes: the flow itself, or every flow under the folder (at any depth). Archiving
 * takes the active ones; deleting an archived folder takes the archived ones (what is under it).
 */
export function flowsTaken(contents: ProjectContents, kind: 'folder' | 'flow', id: string, archived: boolean): Flow[] {
    if (kind === 'flow') {
        return contents.flows.filter(f => f.id === id);
    }

    const subtree = subtreeIds(contents.folders, id);
    return contents.flows.filter(f => f.folderId !== null && subtree.has(f.folderId) && (f.archivedAt !== null) === archived);
}

/** what of these flows runs by itself and is turned off: deployed, schedules on, webhooks on (each the flows' names) */
export type TriggersOn = { deployed: string[]; schedules: string[]; webhooks: string[] };

export function triggersOn(flows: Flow[]): TriggersOn {
    return {
        deployed: flows.filter(f => f.deployedVersion !== null && f.deployedVersion !== undefined).map(f => f.name),
        schedules: flows.filter(f => (f.schedules?.on ?? 0) > 0).map(f => f.name),
        webhooks: flows.filter(f => (f.webhooks?.on ?? 0) > 0).map(f => f.name),
    };
}

export const anyTriggerOn = (on: TriggersOn) => on.deployed.length + on.schedules.length + on.webhooks.length > 0;
