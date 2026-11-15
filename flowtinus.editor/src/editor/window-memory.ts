import type { WindowPosition, WindowSize } from './floating-window';

/*
 * Where each component's window was and its size, as in the PoC: per flow and component, kept in this browser
 * (localStorage: in every tab, and after it closes), outside the flow and Ctrl+Z. Reopened, the window comes back where
 * it was, with the size it had.
 */

export type RememberedWindow = { position?: WindowPosition; size?: WindowSize };

const key = (flowId: string, nodeId: string) => `flowtinus.window:${flowId}:${nodeId}`;

export function readWindow(flowId: string, nodeId: string): RememberedWindow {
    try {
        return JSON.parse(localStorage.getItem(key(flowId, nodeId)) ?? '{}') as RememberedWindow;
    } catch {
        return {};
    }
}

export function rememberWindow(flowId: string, nodeId: string, update: RememberedWindow) {
    try {
        localStorage.setItem(key(flowId, nodeId), JSON.stringify({ ...readWindow(flowId, nodeId), ...update }));
    } catch {
        // no storage: it opens in the default place next time
    }
}

/** where the canvas was looking (pan and zoom), per flow in this browser (every tab): not part of the flow, never saved with it */
export type Viewport = { x: number; y: number; zoom: number };

export function readViewport(flowId: string): Viewport | null {
    try {
        const view = JSON.parse(localStorage.getItem(`flowtinus.viewport:${flowId}`) ?? 'null') as Viewport | null;
        return view && [view.x, view.y, view.zoom].every(Number.isFinite) ? view : null;
    } catch {
        return null;
    }
}

export function rememberViewport(flowId: string, view: Viewport) {
    try {
        localStorage.setItem(`flowtinus.viewport:${flowId}`, JSON.stringify(view));
    } catch {
        // no storage: the whole flow is fitted on screen next time
    }
}
