// PROTOTYPE (#86): throwaway. Inside VS Code the editor's fetch('/api/...') goes to the extension by postMessage;
// in a browser test (no acquireVsCodeApi) it goes to the test server as it is.
declare const acquireVsCodeApi: undefined | (() => { postMessage(msg: unknown): void });

export const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

if (vscodeApi) {
    const waiting = new Map<number, (answer: { status: number; body: unknown }) => void>();
    let next = 0;
    window.addEventListener('message', e => {
        if (e.data?.type === 'apiAnswer') {
            waiting.get(e.data.id)?.(e.data);
            waiting.delete(e.data.id);
        }
    });
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
        if (!url.startsWith('/api')) {
            return realFetch(input, init);
        }
        const id = next++;
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        vscodeApi.postMessage({ type: 'api', id, method: init?.method ?? 'GET', url, body });
        return new Promise(resolve =>
            waiting.set(id, a =>
                resolve(new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } })),
            ),
        );
    };
}

// the file's errors over the canvas (the page itself only learns of them on Run): click one to open the text at its line
if (vscodeApi) {
    const api = vscodeApi;
    const banner = document.createElement('div');
    banner.style.cssText =
        'position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:2147483647;max-width:min(720px,90vw);display:none;' +
        'background:#7f1d1d;color:#fff;border:1px solid #ef4444;border-radius:8px;padding:10px 14px;font:13px system-ui,sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.5)';
    window.addEventListener('message', e => {
        if (e.data?.type !== 'fileIssues') {
            return;
        }
        const errors = e.data.errors as { message: string; line: number }[];
        banner.style.display = errors.length ? 'block' : 'none';
        banner.replaceChildren();
        const title = document.createElement('div');
        title.style.cssText = 'font-weight:600;margin-bottom:6px';
        title.textContent = `This file is not valid (${errors.length} error${errors.length === 1 ? '' : 's'}): the canvas shows its last valid version, and Run will not run it.`;
        banner.append(title);
        for (const error of errors) {
            const item = document.createElement('div');
            item.style.cssText = 'cursor:pointer;text-decoration:underline;margin-top:2px;white-space:pre-wrap';
            item.textContent = `Line ${error.line + 1}: ${error.message.split('\n')[0]}`;
            item.onclick = () => api.postMessage({ type: 'openAt', line: error.line });
            banner.append(item);
        }
    });
    const mount = () => {
        document.body.append(banner);
        api.postMessage({ type: 'shimReady' });
    };
    if (document.body) {
        mount();
    } else {
        window.addEventListener('DOMContentLoaded', mount);
    }
}
