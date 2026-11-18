import { dropDanglingEdges, newFlowFile, validateFlowFile, type FlowFile } from '@flowtinus/core';
import { withoutPinned } from '#features/pins/pins';
import type { Flow } from './flow';

/*
 * A flow's draft (flows.draft_definition): the core's flow file as the editor saves it, with a revision that grows on
 * every save. A save names the revision it started from; when another save came in between, it is refused (409)
 * instead of overwriting it. A flow made before drafts existed (or by the create without one) opens as a new flow:
 * its Start and its End.
 */

export type StoredDraft = { revision: number; flow: FlowFile };

/** conflict: with git on, the commit the draft could not be merged with (it cannot be committed until it is discarded) */
export type FlowDraft = { flow: FlowFile; revision: number; conflict?: string };

export function readDraft(row: Flow): FlowDraft {
    const stored = row.draftDefinition as Partial<StoredDraft> | null;
    // an edge left on a port its component no longer has (saved before they were taken out) is dropped, not the flow
    const checked = stored?.flow ? validateFlowFile(dropDanglingEdges(stored.flow)) : null;
    const flow = checked?.ok ? checked.value : newFlowFile(row.name, row.id);
    return {
        flow: withoutPinned({ ...flow, id: row.id, name: row.name }),
        revision: checked?.ok && typeof stored?.revision === 'number' ? stored.revision : 0,
    };
}

export const revisionOf = (row: Flow) => {
    const stored = row.draftDefinition as Partial<StoredDraft> | null;
    return stored?.flow && typeof stored.revision === 'number' ? stored.revision : 0;
};
