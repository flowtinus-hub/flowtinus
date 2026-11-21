import { useSyncExternalStore } from 'react';

/*
 * Work the page has not saved yet (a flow's draft or a script waiting for its save, or being saved). While there is
 * some, a branch switch and a commit wait: the save would land on the other branch, or the commit would miss it.
 */

const busy = new Map<string, string>();
const listeners = new Set<() => void>();
let reason: string | null = null;

/** `why` while `source` has a save waiting or under way; null once it is saved (or gone) */
export function setUnsavedWork(source: string, why: string | null): void {
    if (why) {
        busy.set(source, why);
    } else {
        busy.delete(source);
    }
    const next = busy.values().next().value ?? null;
    if (next !== reason) {
        reason = next;
        listeners.forEach(listener => listener());
    }
}

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** why a branch switch or a commit waits now, or null */
export const useUnsavedWork = (): string | null => useSyncExternalStore(subscribe, () => reason);
