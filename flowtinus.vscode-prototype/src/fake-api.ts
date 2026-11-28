// PROTOTYPE (#86): throwaway. The editor's /api answered from the repository's files instead of a server: what it
// cannot answer (runs, schedules, webhooks, deploy...) is refused, and every path asked is logged. The list of paths is
// the host interface the real canvas needs.
import { repoFlowFromYaml, repoFlowToYaml, type FlowFile } from '../../flowtinus.core/src/index';
import type { Index } from './repo';

export type ApiHost = {
    index: () => Index | undefined;
    read: (path: string) => string;
    write: (path: string, text: string) => Promise<void>;
    revision: (path: string) => number;
    log: (line: string) => void;
    /** the server a personal access token connects to: Run goes there, with the file's content */
    server?: () => { url: string; token: string } | undefined;
};

/** the server's answer, as it gave it: only the run calls go there, with the token */
async function forward(host: ApiHost, method: string, path: string, body: unknown): Promise<ApiAnswer> {
    const server = host.server?.();
    if (!server) {
        return refused(path);
    }
    try {
        const response = await fetch(`${server.url}${path}`, {
            method,
            headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => ({})) };
    } catch (e) {
        return { status: 503, body: { error: { code: 'unavailable', message: `The server ${server.url} does not answer: ${String(e)}` } } };
    }
}

export type ApiAnswer = { status: number; body: unknown };

const refused = (path: string): ApiAnswer => ({
    status: 404,
    body: { error: { code: 'not_in_vscode', message: `Not available in VS Code (prototype): ${path}` } },
});

const ok = (body: unknown): ApiAnswer => ({ status: 200, body });

function findFlow(host: ApiHost, id: string) {
    for (const ws of host.index()?.workspaces.values() ?? []) {
        const flow = ws.flows.get(id);
        if (flow) {
            return { ws, flow };
        }
    }
    return undefined;
}

export const projectIdOf = (host: ApiHost, workspace: string, project: string): string => {
    const text = host.index()?.files[`${workspace}/projects/${project}/project.yaml`] ?? '';
    return text.match(/^id:\s*(\S+)/m)?.[1] ?? project;
};

export async function answer(host: ApiHost, method: string, url: string, body: unknown): Promise<ApiAnswer> {
    const path = url.replace(/^\/api/, '').split('?')[0]!;
    const result = await route(host, method, path, body);
    host.log(`${result.status < 300 ? 'ok     ' : 'REFUSED'} ${method} ${url}`);
    return result;
}

async function route(host: ApiHost, method: string, path: string, body: unknown): Promise<ApiAnswer> {
    const workspaces = [...(host.index()?.workspaces.keys() ?? [])];
    // Run: the developer's file, not the server's draft, goes with the request (a test run of that content)
    const run = path.match(/^\/w\/[^/]+\/flows\/([^/]+)\/runs$/);
    if (run && method === 'POST') {
        const found = findFlow(host, run[1]!);
        const read = found && repoFlowFromYaml(host.read(found.flow.path), found.flow.name.split('/').pop()!);
        if (!read?.ok) {
            return {
                status: 422,
                body: {
                    error: {
                        code: 'invalid',
                        message: `The file does not read as a flow: ${read && !read.ok ? read.errors.join(' ') : 'not found'} Fix it in the text (the canvas shows its last valid version).`,
                    },
                },
            };
        }
        return forward(host, method, path, { ...(body as object), flow: read.value.flow });
    }
    if (/^\/runs\/[^/]+(\/cancel)?$/.test(path) || /^\/w\/[^/]+\/flows\/[^/]+\/last-run$/.test(path)) {
        return forward(host, method, path, body);
    }
    if (path === '/health') {
        // a local server: the editor already turns off git, promotion, the provider and the environments for it
        return ok({ status: 'ok', environment: 'LOCAL' });
    }
    if (path === '/me') {
        return ok({
            id: '00000000-0000-4000-8000-000000000000',
            name: 'VS Code',
            email: 'vscode@example.invalid',
            handle: 'vscode',
            isAdmin: false,
            workspaces: workspaces.map(w => ({ workspaceId: w, handle: w, name: w, role: 'editor' })),
        });
    }
    const m = path.match(/^\/w\/([^/]+)(\/.*)?$/);
    if (!m) {
        return refused(path);
    }
    const [, ws, rest = ''] = m;
    const draft = rest.match(/^\/flows\/([^/]+)\/draft$/);
    if (draft) {
        const found = findFlow(host, draft[1]!);
        if (!found) {
            return { status: 404, body: { error: { code: 'not_found', message: 'No such flow' } } };
        }
        const name = found.flow.name.split('/').pop()!;
        const read = repoFlowFromYaml(host.read(found.flow.path), name);
        if (!read.ok) {
            return { status: 422, body: { error: { code: 'invalid', message: read.errors.join(' ') } } };
        }
        if (method === 'GET') {
            return ok({ flow: read.value.flow, revision: host.revision(found.flow.path) });
        }
        if (method === 'PUT') {
            const { flow } = body as { flow: FlowFile };
            const { flow: _old, ...triggers } = read.value;
            await host.write(found.flow.path, repoFlowToYaml({ ...flow, id: read.value.flow.id }, triggers));
            return ok({ revision: host.revision(found.flow.path) });
        }
    }
    if (/^\/flows\/[^/]+\/pins$/.test(rest) && method === 'GET') {
        return ok({ pins: {} });
    }
    const workspace = host.index()?.workspaces.get(ws!);
    if (!workspace || method !== 'GET') {
        return refused(path);
    }
    const now = new Date().toISOString();
    const projects = [...new Set([...workspace.flows.values()].map(f => f.type!))];
    const projectDto = (handle: string) => {
        const id = projectIdOf(host, ws!, handle);
        return { id, name: handle, handle, description: '', icon: '', color: '', createdAt: now, archivedAt: null };
    };
    const flowDto = (f: { id: string; name: string; type?: string }) => {
        const folders = f.name.split('/').slice(0, -1);
        return {
            id: f.id,
            projectId: projectIdOf(host, ws!, f.type!),
            folderId: folders.length ? folders.join('/') : null,
            name: f.name.split('/').pop()!,
            workerTag: 'default',
            createdAt: now,
            updatedAt: now,
            updatedBy: null,
            archivedAt: null,
        };
    };
    const flowMeta = rest.match(/^\/flows\/([^/]+)$/);
    if (flowMeta) {
        const found = findFlow(host, flowMeta[1]!);
        return found ? ok(flowDto(found.flow)) : refused(path);
    }
    const project = rest.match(/^\/projects\/([^/]+)(\/contents)?$/);
    if (project) {
        const handle = projects.find(p => projectIdOf(host, ws!, p) === project[1]);
        if (!handle) {
            return refused(path);
        }
        if (!project[2]) {
            return ok(projectDto(handle));
        }
        const flows = [...workspace.flows.values()].filter(f => f.type === handle).map(flowDto);
        const folderPaths = new Set(
            flows.flatMap(f => (f.folderId ? f.folderId.split('/').map((_, i, a) => a.slice(0, i + 1).join('/')) : [])),
        );
        const folders = [...folderPaths].map(p => ({
            id: p,
            projectId: projectIdOf(host, ws!, handle),
            parentId: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null,
            name: p.split('/').pop()!,
            createdAt: now,
            archivedAt: null,
        }));
        return ok({ folders, flows });
    }
    if (rest === '/connections') {
        const items = [...workspace.connections.values()].map(c => ({
            id: c.id,
            name: c.name,
            type: c.type,
            config: {},
            createdAt: now,
            updatedAt: now,
            updatedBy: null,
        }));
        return ok({ items });
    }
    if (rest === '/secrets' || rest === '/variables') {
        // the developer's machine has none: a local server keeps its own in Postgres
        return ok({ items: [] });
    }
    return refused(path);
}
