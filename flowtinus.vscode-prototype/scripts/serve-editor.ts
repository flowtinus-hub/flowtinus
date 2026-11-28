// PROTOTYPE (#86): throwaway. The webview's editor in a plain browser, its /api answered by the same fake API from
// the sample repository on disk: bun scripts/serve-editor.ts, then open the printed address.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answer, projectIdOf, type ApiHost } from '../src/fake-api';
import { buildIndex, type Index } from '../src/repo';

const here = join(import.meta.dir, '..');
const sample = join(tmpdir(), 'flowtinus-vscode-prototype-sample-WIPE-ME');
let index: Index = buildIndex(sample, {});

const host: ApiHost = {
    index: () => index,
    read: path => readFileSync(join(sample, path), 'utf8'),
    write: async (path, text) => {
        writeFileSync(join(sample, path), text);
        index = buildIndex(sample, {});
    },
    revision: path => Math.round(statSync(join(sample, path)).mtimeMs),
    log: line => console.log(line),
    server: () => (process.env.FLOWTINUS_TOKEN ? { url: 'http://localhost:5190', token: process.env.FLOWTINUS_TOKEN } : undefined),
};

const ws = process.env.WS ?? 'acme';
const flow = [...index.workspaces.get(ws)!.flows.values()].find(f => f.name === (process.env.FLOW ?? 'orders/Load orders'))!;
const route = `/w/${ws}/projects/${projectIdOf(host, ws, flow.type!)}/flows/${flow.id}`;

const page = `<!doctype html><html class="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/editor.css"></head>
<body><div id="root" style="height:100vh"></div><script>window.FLOWTINUS_ROUTE=${JSON.stringify(route)};window.FLOWTINUS_CAN=${JSON.stringify(process.env.FLOWTINUS_TOKEN ? ['run'] : [])}</script>
<script type="module" src="/editor.js"></script></body></html>`;

Bun.serve({
    port: 5198,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.startsWith('/api')) {
            const body = req.method === 'GET' ? undefined : await req.json().catch(() => undefined);
            const a = await answer(host, req.method, url.pathname + url.search, body);
            return Response.json(a.body, { status: a.status });
        }
        if (url.pathname === '/') {
            return new Response(page, { headers: { 'content-type': 'text/html' } });
        }
        const file = Bun.file(join(here, 'out', 'editor', url.pathname));
        return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
    },
});
console.log(`http://localhost:5198/  (route ${route})`);
