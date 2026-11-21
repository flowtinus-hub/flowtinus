import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Node } from '@xyflow/react';
import type { FlowFile } from '@flowtinus/core';
import { getDraft, getPins, saveDraft, setPin, unpin, type Pinned } from '@/data/flows/flows-api';
import type { ApiError } from '@/lib/api';
import { useServerConnection } from '@/lib/server-connection';
import { canvasToFlowFile, flowFileToCanvas } from './flow-file';

/*
 * The flow's draft on the server: opened with the editor, saved by itself a moment after each change (as in the PoC),
 * right away with Ctrl+S, and when the page closes or is hidden. Only what is in the flow file counts as a change
 * (selecting, zooming or panning saves nothing). A save that another one beat (409) stops the saves until the flow is
 * reloaded; one the server could not take is tried again when the server is back. A flow the server no longer has as
 * active (archived or removed: the save answers not found) stops the saves too, nothing to retry. An archived flow opens
 * read-only: nothing is saved until it is restored.
 */

/** how long after the last change the draft is saved */
export const AUTOSAVE_DELAY_MS = 1_000;

export type SaveState =
    | { status: 'loading' }
    | { status: 'saved' }
    | { status: 'pending' }
    | { status: 'saving' }
    | { status: 'error'; message: string }
    | { status: 'conflict' }
    /** the save answered not found: the flow was archived or removed (no retry) */
    | { status: 'gone' }
    /** an archived flow, open to read: nothing is saved */
    | { status: 'read-only' };

/** what a save the server refused leaves: a conflict (reload), a flow gone (archived or removed), or an error to retry */
export function stateAfterRefusedSave(error: ApiError): SaveState {
    if (error.code === 'conflict') {
        return { status: 'conflict' };
    }

    return error.code === 'not-found' ? { status: 'gone' } : { status: 'error', message: error.message };
}

/** how a flush ended: saved (a run runs what is saved), not saved, the flow gone, or read-only */
export type FlushResult = 'saved' | 'not-saved' | 'gone' | 'read-only';

const sortedKeys = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(sortedKeys)
        : value && typeof value === 'object'
          ? Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map(key => [key, sortedKeys((value as Record<string, unknown>)[key])]),
            )
          : value;

const byKey =
    <T>(key: (item: T) => string) =>
    (a: T, b: T) =>
        key(a).localeCompare(key(b));

const withoutPinned = (file: FlowFile): FlowFile => ({ ...file, nodes: file.nodes.map(({ pinned: _pinned, ...n }) => n) });

const pinsOfFile = (file: FlowFile) => new Map(file.nodes.flatMap(n => (n.pinned ? [[n.id, n.pinned as Pinned] as const] : [])));

const pinsChanged = (now: Map<string, Pinned>, synced: Map<string, Pinned>) =>
    now.size !== synced.size || [...now].some(([id, pinned]) => synced.get(id) !== pinned);

/**
 * What is compared to know whether the canvas changed since the last save, in any order: the server gives the
 * components in the repository's order (by id), the canvas in its own (containers first), so a flow just opened would
 * otherwise look changed and save itself.
 */
export const draftFingerprint = (file: FlowFile) =>
    JSON.stringify(
        sortedKeys({
            nodes: withoutPinned(file).nodes.sort(byKey(n => n.id)),
            edges: [...file.edges].sort(byKey(e => [e.source, e.sourcePort, e.target, e.targetPort].join('|'))),
            groups: [...(file.groups ?? [])].sort(byKey(g => g.id)),
        }),
    );

/** the draft's state and what can be done with it (the top bar shows it) */
export type DraftSave = {
    state: SaveState;
    saveNow: () => void;
    reload: () => void;
    /** after a restore: the server's revision read again, the canvas kept as it is (and saved if it differs) */
    resume: () => Promise<void>;
    /** saves what is pending now; 'saved' once the server has the canvas as it is (a run runs what is saved) */
    flush: () => Promise<FlushResult>;
};

export function useFlowDraft(
    flowId: string,
    canvas: { nodes: Node[]; edges: Edge[] },
    load: (canvas: ReturnType<typeof flowFileToCanvas>) => void,
    readOnly = false,
    held?: () => void,
): DraftSave {
    const [state, setState] = useState<SaveState>({ status: 'loading' });
    const readOnlyRef = useRef(readOnly);
    const heldRef = useRef(held);
    const online = useServerConnection().state === 'online';
    // what the server has: its revision, the flow's name, and what was saved (to tell a real change)
    const server = useRef<{ revision: number; name: string; saved: string } | null>(null);
    const saving = useRef(false);
    const pinsSynced = useRef(new Map<string, Pinned>());
    const pinning = useRef<Promise<boolean> | null>(null);
    // the last save answered not found (archived or removed)
    const gone = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const latest = useRef(canvas);
    const loadRef = useRef(load);
    // the save after a save (the canvas changed while it was saving)
    const again = useRef<() => void>(() => {});
    useLayoutEffect(() => {
        latest.current = canvas;
        loadRef.current = load;
        readOnlyRef.current = readOnly;
        heldRef.current = held;
    });

    const fileNow = useCallback(
        () => canvasToFlowFile({ id: flowId, name: server.current?.name ?? '' }, latest.current.nodes, latest.current.edges),
        [flowId],
    );

    const open = useCallback(
        async (showLoading = true) => {
            if (showLoading) {
                setState({ status: 'loading' });
            }

            server.current = null;
            gone.current = false;
            const [result, pins] = await Promise.all([getDraft(flowId), getPins(flowId)]);
            if (!result.ok || !pins.ok) {
                setState({ status: 'error', message: (!result.ok ? result.error : (pins as { error: ApiError }).error).message });
                return;
            }

            const { flow, revision } = result.value;
            const mine = pins.value.pins;
            const pinned = { ...flow, nodes: flow.nodes.map(n => (mine[n.id] ? { ...n, pinned: mine[n.id] } : n)) };
            pinsSynced.current = pinsOfFile(pinned);
            server.current = { revision, name: flow.name, saved: draftFingerprint(flow) };
            loadRef.current(flowFileToCanvas(pinned));
            setState({ status: 'saved' });
        },
        [flowId],
    );

    const syncPins = useCallback(
        (keepalive = false): Promise<boolean> => {
            const run = async (): Promise<boolean> => {
                for (;;) {
                    if (!server.current || readOnlyRef.current) {
                        return true;
                    }

                    const now = pinsOfFile(fileNow());
                    const synced = pinsSynced.current;
                    if (!pinsChanged(now, synced)) {
                        return true;
                    }

                    for (const [id, pinned] of now) {
                        if (synced.get(id) !== pinned) {
                            const result = await setPin(flowId, id, pinned, keepalive);
                            if (!result.ok) {
                                setState(stateAfterRefusedSave(result.error));
                                return false;
                            }
                            synced.set(id, pinned);
                        }
                    }
                    for (const id of [...synced.keys()].filter(id => !now.has(id))) {
                        const result = await unpin(flowId, id, keepalive);
                        if (!result.ok) {
                            setState(stateAfterRefusedSave(result.error));
                            return false;
                        }
                        synced.delete(id);
                    }
                }
            };
            // one at a time: the next starts when the one under way ended, from the canvas as it is then
            const next = (pinning.current ?? Promise.resolve(true)).then(run);
            pinning.current = next;
            void next.finally(() => {
                if (pinning.current === next) {
                    pinning.current = null;
                }
            });
            return next;
        },
        [flowId, fileNow],
    );

    const save = useCallback(
        async (keepalive = false) => {
            clearTimeout(timer.current);
            const at = server.current;
            if (!at || saving.current || readOnlyRef.current || heldRef.current) {
                return;
            }

            const file = fileNow();
            const print = draftFingerprint(file);
            if (print === at.saved) {
                setState({ status: 'saved' });
                return;
            }

            saving.current = true;
            setState({ status: 'saving' });
            const result = await saveDraft(flowId, at.revision, withoutPinned(file), keepalive);
            saving.current = false;
            if (result.ok) {
                server.current = { ...at, revision: result.value.revision, saved: print };
                // changed while it was saving: one more save
                if (draftFingerprint(fileNow()) !== print) {
                    setState({ status: 'pending' });
                    timer.current = setTimeout(() => again.current(), AUTOSAVE_DELAY_MS);
                } else {
                    setState({ status: 'saved' });
                }
            } else {
                const next = stateAfterRefusedSave(result.error);
                gone.current = next.status === 'gone';
                // a conflict or a flow gone: no more saves from here (until reloaded or restored)
                if (next.status !== 'error') {
                    server.current = null;
                }

                setState(next);
            }
        },
        [flowId, fileNow],
    );
    useEffect(() => {
        again.current = () => void save();
    }, [save]);

    // opens the draft when the editor opens a flow (a fetch: its answer sets the state)
    const openRef = useRef(open);
    useLayoutEffect(() => {
        openRef.current = open;
    });
    useEffect(() => {
        void openRef.current(false);
        return () => clearTimeout(timer.current);
    }, [flowId]);

    useEffect(() => {
        if (server.current && !readOnly && pinsChanged(pinsOfFile(fileNow()), pinsSynced.current)) {
            void syncPins();
        }
    }, [canvas.nodes, fileNow, syncPins, readOnly]);

    // a change: saved a moment later (each new change waits again)
    useEffect(() => {
        const at = server.current;
        // a drag moves a node on every frame: building and comparing the whole file each time freezes the canvas
        if (canvas.nodes.some(n => n.dragging)) {
            clearTimeout(timer.current);
            return;
        }

        if (!at || readOnly) {
            return;
        }
        // back to what the server has (dragged away and back): nothing to save, and the save waiting goes
        if (draftFingerprint(fileNow()) === at.saved) {
            clearTimeout(timer.current);
            setState(current => (current.status === 'pending' || current.status === 'error' ? { status: 'saved' } : current));
            return;
        }
        if (heldRef.current) {
            heldRef.current();
            return;
        }

        setState(current => (current.status === 'saving' ? current : { status: 'pending' }));
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    }, [canvas.nodes, canvas.edges, fileNow, save, readOnly]);

    // the server is back: what failed (or never opened) goes now
    useEffect(() => {
        if (!online) {
            return;
        }

        if (state.status === 'error') {
            void (server.current ? syncPins().then(sent => (sent ? save() : undefined)) : open());
        }
    }, [online, state.status, save, syncPins, open]);

    // the page closes or is hidden: what is pending goes now (and may still reach the server after the page is gone)
    useEffect(() => {
        const flush = () => {
            if (server.current && pinsChanged(pinsOfFile(fileNow()), pinsSynced.current)) {
                void syncPins(true);
            }
            if (server.current && draftFingerprint(fileNow()) !== server.current.saved) {
                void save(true);
            }
        };
        const hidden = () => document.visibilityState === 'hidden' && flush();
        window.addEventListener('pagehide', flush);
        document.addEventListener('visibilitychange', hidden);
        return () => {
            window.removeEventListener('pagehide', flush);
            document.removeEventListener('visibilitychange', hidden);
        };
    }, [fileNow, save, syncPins]);

    // the same object while nothing changes (the page keeps it in its state)
    const saveNow = useCallback(() => void save(), [save]);
    const flush = useCallback(async (): Promise<FlushResult> => {
        if (readOnlyRef.current) {
            return 'read-only';
        }

        // a test run replays the pins the server has: they go first
        const pinsSent = await syncPins();
        await save();
        if (pinsSent && server.current !== null && draftFingerprint(fileNow()) === server.current.saved) {
            return 'saved';
        }

        return gone.current ? 'gone' : 'not-saved';
    }, [save, syncPins, fileNow]);
    const reload = useCallback(() => void open(), [open]);
    const resume = useCallback(async () => {
        const result = await getDraft(flowId);
        if (!result.ok) {
            setState({ status: 'error', message: result.error.message });
            return;
        }

        gone.current = false;
        const { flow, revision } = result.value;
        server.current = { revision, name: flow.name, saved: draftFingerprint(flow) };
        // what changed here while it could not save goes now
        if (draftFingerprint(fileNow()) === server.current.saved) {
            setState({ status: 'saved' });
        } else {
            await save();
        }
    }, [flowId, fileNow, save]);
    // read-only (archived): that is what it says, whatever the last save did; restored, the save state again
    const shown = useMemo<SaveState>(() => (readOnly && state.status !== 'loading' ? { status: 'read-only' } : state), [readOnly, state]);
    return useMemo(() => ({ state: shown, saveNow, reload, resume, flush }), [shown, saveNow, reload, resume, flush]);
}
