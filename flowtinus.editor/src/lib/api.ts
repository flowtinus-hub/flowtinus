import { mockUser } from '@/auth/mock-user';
import { reportReachable, reportUnavailable } from './server-connection';

/*
 * Calls to flowtinus.server. In dev Vite proxies /api to it (vite.config.ts). Who is calling goes in X-User-Id until
 * there is authentication (then a token replaces it here, and nothing else changes). A workspace's data is under
 * /w/<its handle>; the environment's (the runs, the workers, the user and their workspaces) is not.
 */

/** the workspace of the page (its handle), set by its route (WorkspaceScope): the data calls of its pages go to it */
let currentWorkspace = '';

export const setCurrentWorkspace = (handle: string) => {
    currentWorkspace = handle;
};

export const getCurrentWorkspace = () => currentWorkspace;

/** the environment's paths, and a workspace's own (/w/<handle>...), go as they are */
const AS_IS = /^\/(runs|workers|me|workspaces|tokens|health|w)(\/|\?|$)/;

/** the api's address of a path: a workspace's under /w/<handle> (the page's workspace unless given) */
export const apiPath = (path: string, workspace = currentWorkspace) => (AS_IS.test(path) ? path : `/w/${workspace}${path}`);

export type ApiError = {
    code: string;
    message: string;
    /** per field, for validation and conflict errors: { name: 'Already in use' } */
    fields?: Record<string, string>;
};

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

const UNAVAILABLE: ApiError = { code: 'unavailable', message: 'Server unavailable' };

/** who is calling, as every request to the api says it (until there is authentication) */
export const apiHeaders = (): Record<string, string> => ({ 'x-user-id': mockUser.id });

/** a request to the api: the value, or the error the server answered ({ error: { code, message, fields } }) */
export const API_WRITE_DONE = 'flowtinus:api-write-done';

export async function api<T>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<ApiResult<T>> {
    let response: Response;
    try {
        response = await fetch(`/api${apiPath(path)}`, {
            method: init.method ?? 'GET',
            headers: {
                'x-user-id': mockUser.id,
                ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            // a save sent while the page closes still reaches the server
            keepalive: init.keepalive,
        });
    } catch {
        reportUnavailable();
        return { ok: false, error: UNAVAILABLE };
    }

    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
        reportReachable();
        if ((init.method ?? 'GET') !== 'GET') {
            window.dispatchEvent(new Event(API_WRITE_DONE));
        }
        return { ok: true, value: body as T };
    }

    const error = (body as { error?: ApiError } | undefined)?.error;
    if (error?.code && error.message) {
        // an answer of ours: the server is there
        reportReachable();
        return { ok: false, error };
    }

    // the proxy answers 5xx without a body of ours when the server is down
    if (response.status >= 500) {
        reportUnavailable();
    }

    return { ok: false, error: response.status >= 500 ? UNAVAILABLE : { code: 'http', message: `Request failed (${response.status}).` } };
}
