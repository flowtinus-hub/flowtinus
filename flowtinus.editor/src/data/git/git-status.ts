import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useLocalServer } from '@/lib/server-connection';
import { getGitStatus, GIT_STATUS_CHANGED, TREE_APPLIED, type GitStatus } from './git-api';

const GIT_STATUS_MS = 60_000;
const DISK_STATUS_MS = 5_000;

type Watched = { value: GitStatus | null; listeners: Set<() => void>; reading: boolean; stop?: () => void };

const watched = new Map<string, Watched>();

const entryOf = (handle: string): Watched => {
    let entry = watched.get(handle);
    if (!entry) {
        entry = { value: null, listeners: new Set(), reading: false };
        watched.set(handle, entry);
    }
    return entry;
};

function treeApplied(before: GitStatus | null, after: GitStatus): boolean {
    if (before?.on && after.on) {
        return before.deploy?.sha !== after.deploy?.sha;
    }
    if (before && !before.on && before.disk && !after.on && after.disk) {
        return before.disk.appliedAt !== after.disk.appliedAt;
    }
    return false;
}

function read(handle: string): void {
    const entry = entryOf(handle);
    if (entry.reading) {
        return;
    }
    entry.reading = true;
    void getGitStatus(handle).then(result => {
        entry.reading = false;
        if (result.ok) {
            const applied = treeApplied(entry.value, result.value);
            entry.value = result.value;
            entry.listeners.forEach(listener => listener());
            if (applied) {
                window.dispatchEvent(new Event(TREE_APPLIED));
            }
        }
    });
}

function watch(handle: string, everyMs: number, listener: () => void): () => void {
    const entry = entryOf(handle);
    entry.listeners.add(listener);
    if (entry.listeners.size === 1) {
        const again = () => read(handle);
        const timer = setInterval(again, everyMs);
        window.addEventListener(GIT_STATUS_CHANGED, again);
        entry.stop = () => {
            clearInterval(timer);
            window.removeEventListener(GIT_STATUS_CHANGED, again);
        };
        read(handle);
    }
    return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) {
            entry.stop?.();
        }
    };
}

const none = () => () => {};

export function useGitStatus(handle: string | null, pathname?: string): GitStatus | null {
    const everyMs = useLocalServer() ? DISK_STATUS_MS : GIT_STATUS_MS;
    const subscribe = useCallback((listener: () => void) => (handle ? watch(handle, everyMs, listener) : none()), [handle, everyMs]);
    const value = useSyncExternalStore(subscribe, () => (handle ? (watched.get(handle)?.value ?? null) : null));
    useEffect(() => {
        if (handle) {
            read(handle);
        }
    }, [handle, pathname]);
    return value;
}
