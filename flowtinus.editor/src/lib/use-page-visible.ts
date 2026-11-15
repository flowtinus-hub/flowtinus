import { useSyncExternalStore } from 'react';

/*
 * Whether the tab is shown. A hidden tab lets its live streams (SSE) go: the browser opens at most 6 connections at a
 * time to a server over HTTP/1.1, for all its tabs together, and a stream holds one for as long as it is open. Past
 * that, every other request of every tab waits (a tab that does not load, /health timing out: "offline" everywhere).
 */

const subscribe = (onChange: () => void) => {
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
};

export const isPageHidden = () => typeof document !== 'undefined' && document.hidden;

export function usePageVisible(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => !document.hidden,
        () => true,
    );
}
