import { expect, test } from 'bun:test';
import { COMPONENTS, flowRunner, multipartBody, retryAfterMs, retryDelayMs, writesOutside } from '../../src/index';
import type { ExecutableFlow, HttpRequest, HttpResponse } from '../../src/index';
import { evaluate } from '../helpers';

/** Data Grid (3 sectors) → HTTP Request → End. */
const flow = (config: Record<string, unknown>): ExecutableFlow => ({
    project: 'Test',
    flow: 'HTTP',
    parameters: [{ name: 'groupId', type: 'text', default: 'g-1' }],
    nodes: [
        { id: 'start', type: 'start', label: 'Start', config: {} },
        {
            id: 'grid',
            type: 'datagrid',
            label: 'Sectors',
            override: true,
            config: {
                columns: [
                    { name: 'id', type: 'number' },
                    { name: 'name', type: 'text' },
                ],
                rows: [
                    ['1', 'Production'],
                    ['2', 'Clean room'],
                    ['3', 'Administration'],
                ],
            },
        },
        { id: 'http', type: 'http-request', label: 'Sectors API', outputKey: 'response', config: { onError: 'continue', ...config } },
        { id: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges: [
        { source: 'start', sourcePort: 'out-0', target: 'grid', targetPort: 'in-0' },
        { source: 'grid', sourcePort: 'out-0', target: 'http', targetPort: 'in-0' },
        { source: 'http', sourcePort: 'out-0', target: 'end', targetPort: 'in-0' },
    ],
});

const json = (status: number, value: unknown): HttpResponse => ({
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(value),
});

/** A fake server: records the requests and answers what `answer` says (after `delay` ms). */
function fakeHttp(
    answer: (r: HttpRequest) => HttpResponse = r => json(201, { id: `new-${r.body ? JSON.parse(r.body).name : ''}` }),
    delay: (r: HttpRequest) => number = () => 5,
) {
    const requests: Omit<HttpRequest, 'signal'>[] = [];
    const send = async ({ signal: _signal, ...r }: HttpRequest) => {
        requests.push(r);
        await new Promise(resolve => setTimeout(resolve, delay({ ...r, signal: _signal })));
        return answer({ ...r, signal: _signal });
    };
    return { requests, send };
}

const POST_SECTOR = {
    method: 'POST',
    url: { value: '$SECRETS.API_URL + "/sectors"', expression: true },
    headers: [{ name: 'Authorization', value: "'Bearer ' + $SECRETS.API_TOKEN", expression: true }],
    query: [{ name: 'source', value: 'crm', expression: false }],
    body: { value: '({groupId: $PARAMETERS.groupId, name: $name})', expression: true },
};
const SECRETS = { API_URL: 'https://api.example.com/api', API_TOKEN: 'secret-123456' };
const nodeOf = (r: Awaited<ReturnType<typeof flowRunner>>) => r.components.find(c => c.nodeId === 'http')!;

test('HTTP Request validates and writes only with POST, PUT, PATCH and DELETE', () => {
    expect(
        COMPONENTS['http-request'].validate({
            url: { value: 'api.example.com', expression: false },
            headers: [{ name: 'Bad Header', value: '', expression: false }],
        }),
    ).toEqual(['has a URL that does not start with http:// or https://.', 'header "Bad Header" is not a valid header name.']);
    expect(writesOutside(COMPONENTS['http-request'], { method: 'GET' })).toBe(false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(writesOutside(COMPONENTS['http-request'], { method })).toBe(true);
    }
});

test('HTTP Request sends one request per envelope with the evaluated URL, query, headers and JSON body', async () => {
    const http = fakeHttp();
    const r = await flowRunner(flow(POST_SECTOR), { mode: 'execution', id: 'h1', evaluate, http: http.send, secrets: SECRETS });
    expect(r.status).toBe('completed');
    expect(http.requests[0]).toEqual({
        method: 'POST',
        url: 'https://api.example.com/api/sectors?source=crm',
        timeoutMs: 30_000,
        headers: { Authorization: 'Bearer secret-123456', 'content-type': 'application/json' },
        body: '{"groupId":"g-1","name":"Production"}',
    });
    const node = nodeOf(r);
    expect(node.outputSample['out-0'][0]).toEqual({
        id: 1,
        name: 'Production',
        response: {
            status: 201,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: { id: 'new-Production' },
        },
    });
    expect(node.logs.at(-1)?.message).toMatch(/^3 request\(s\): 2xx 3, 4xx 0, 5xx 0, errors 0, in \d+ ms\.$/);
    // per request at debug, and never a secret value
    expect(node.logs.filter(l => l.level === 'debug' && l.message.includes(' → '))).toHaveLength(3);
    expect(node.logs.some(l => l.message.includes('secret-123456') || l.message.includes('api.example.com/api'))).toBe(false);
    expect(node.waitingMs).toBeGreaterThan(0);
});

test('HTTP Request: a GET runs in a test run, a POST does not send and logs what it would', async () => {
    const http = fakeHttp(() => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'pong' }));
    const get = await flowRunner(flow({ method: 'GET', url: { value: 'https://example.com/ping', expression: false } }), {
        mode: 'validation',
        id: 'h2',
        evaluate,
        http: http.send,
    });
    expect(http.requests).toHaveLength(3);
    expect(nodeOf(get).outputSample['out-0'][0].response).toEqual({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'pong' });

    const post = await flowRunner(flow(POST_SECTOR), { mode: 'validation', id: 'h3', evaluate, http: http.send, secrets: SECRETS });
    expect(http.requests).toHaveLength(3);
    const node = nodeOf(post);
    expect(node.status).toBe('completed');
    expect(node.outputSample['out-0'].map(d => d.response)).toEqual(Array(3).fill({ notSent: true }));
    expect(
        node.logs.some(l => l.message === 'Test run: POST ***/sectors?source=crm not sent, body {"groupId":"g-1","name":"Production"}.'),
    ).toBe(true);
    expect(node.logs.some(l => l.message.includes('secret-123456'))).toBe(false);
});

test('HTTP Request: an error status goes to the error policy, or on to the output when Fail on non-2xx is off', async () => {
    const http = fakeHttp(r =>
        String(r.body).includes('Clean room') ? json(409, { error: 'Sector already exists' }) : json(201, { id: 'x' }),
    );
    const failing = await flowRunner(flow(POST_SECTOR), { mode: 'execution', id: 'h4', evaluate, http: http.send, secrets: SECRETS });
    const node = nodeOf(failing);
    expect(node.logs.filter(l => l.level === 'error').map(l => l.message)).toEqual([
        'HTTP 409 on POST ***/sectors?source=crm: {"error":"Sector already exists"}',
    ]);
    expect(node.logs.at(-1)?.message).toMatch(/^3 request\(s\): 2xx 2, 4xx 1, 5xx 0, errors 0, in \d+ ms\.$/);

    const passing = await flowRunner(flow({ ...POST_SECTOR, failOnError: false }), {
        mode: 'execution',
        id: 'h5',
        evaluate,
        http: http.send,
        secrets: SECRETS,
    });
    expect(nodeOf(passing).outputSample['out-0'][1].response).toEqual({
        status: 409,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: { error: 'Sector already exists' },
    });
});

test('HTTP Request keeps the arrival order with several requests at once', async () => {
    // the first one answers last
    const http = fakeHttp(
        r => json(200, { name: JSON.parse(String(r.body)).name }),
        r => (String(r.body).includes('Production') ? 40 : 5),
    );
    const r = await flowRunner(flow({ ...POST_SECTOR, concurrency: 3 }), {
        mode: 'execution',
        id: 'h6',
        evaluate,
        http: http.send,
        secrets: SECRETS,
    });
    expect(nodeOf(r).outputSample['out-0'].map(d => (d.response as { body: { name: string } }).body.name)).toEqual([
        'Production',
        'Clean room',
        'Administration',
    ]);
});

test('HTTP Request: no answer (timeout, network) is an error of the envelope, with the secrets hidden', async () => {
    const send = async () => {
        throw new Error('No answer in 30 s (timeout) from https://api.example.com/api/sectors');
    };
    const r = await flowRunner(flow(POST_SECTOR), { mode: 'execution', id: 'h7', evaluate, http: send, secrets: SECRETS });
    const node = nodeOf(r);
    expect(node.logs.filter(l => l.level === 'error').map(l => l.message)).toEqual(
        Array(3).fill('No answer in 30 s (timeout) from ***/sectors'),
    );
    expect(node.logs.at(-1)?.message).toMatch(/errors 3/);
});

test('multipartBody: fields and text files, each with its disposition and type, the boundary in the content type', () => {
    const form = multipartBody(
        [
            { name: 'note', content: 'hello' },
            { name: 'meta', content: { a: 1 } },
            { name: 'upload', content: 'a,b\r\n1,2', filename: 'users "1".csv', contentType: 'text/csv' },
        ],
        'B0UND',
    );
    expect(form.contentType).toBe('multipart/form-data; boundary=B0UND');
    expect(form.body).toBe(
        [
            '--B0UND',
            'Content-Disposition: form-data; name="note"',
            '',
            'hello',
            '--B0UND',
            'Content-Disposition: form-data; name="meta"',
            'Content-Type: application/json',
            '',
            '{"a":1}',
            '--B0UND',
            'Content-Disposition: form-data; name="upload"; filename="users %221%22.csv"',
            'Content-Type: text/csv',
            '',
            'a,b\r\n1,2',
            '--B0UND--',
            '',
        ].join('\r\n'),
    );
});

test('HTTP Request: a multipart body, its file name an expression, replaces a content type the headers set', async () => {
    const http = fakeHttp(() => json(200, { ok: true }));
    const config = {
        method: 'POST',
        url: { value: 'https://api.example.com/upload', expression: false },
        headers: [{ name: 'Content-Type', value: 'application/json', expression: false }],
        bodyType: 'multipart',
        parts: [
            { name: 'kind', value: 'sector', expression: false },
            {
                name: 'file',
                value: '`id,name\\r\\n${$id},${$name}`',
                expression: true,
                filename: { value: '"sector_" + $id + ".csv"', expression: true },
                contentType: 'text/csv',
            },
        ],
    };
    expect(COMPONENTS['http-request'].validate(config)).toEqual([]);
    expect(COMPONENTS['http-request'].validate({ ...config, parts: [] })).toEqual(['has a multipart body without parts.']);
    const r = await flowRunner(flow(config), { mode: 'execution', id: 'hm', evaluate, http: http.send });
    expect(r.status).toBe('completed');
    const sent = http.requests[0]!;
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(sent.headers['content-type'] ?? '')?.[1];
    expect(boundary).toBeString();
    expect(Object.keys(sent.headers).filter(h => h.toLowerCase() === 'content-type')).toEqual(['content-type']);
    expect(sent.body).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nsector\r\n`);
    expect(sent.body).toContain(
        'Content-Disposition: form-data; name="file"; filename="sector_1.csv"\r\nContent-Type: text/csv\r\n\r\nid,name\r\n1,Production\r\n',
    );
    expect(sent.body).toEndWith(`--${boundary}--\r\n`);
});

test('retry delay: Retry-After in seconds or as a date, no retry past the longest wait, otherwise a jittered backoff', () => {
    const now = Date.parse('2026-11-09T01:00:00Z');
    expect(retryAfterMs('5', now)).toBe(5000);
    expect(retryAfterMs('Mon, 09 Nov 2026 01:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryDelayMs(0, '5', 60_000, now)).toBe(5000);
    expect(retryDelayMs(0, '120', 60_000, now)).toBeUndefined();
    // no Retry-After: a random part of 1 s, 2 s, 4 s..., at most the longest wait
    expect(retryDelayMs(0, undefined, 60_000, now, () => 1)).toBe(1000);
    expect(retryDelayMs(2, undefined, 60_000, now, () => 0.5)).toBe(2000);
    expect(retryDelayMs(10, undefined, 3000, now, () => 1)).toBe(3000);
    expect(COMPONENTS['http-request'].settings?.find(s => s.key === 'retries')?.default).toBe(3);
});

test('HTTP Request retries a 429 after its Retry-After (also a POST: it was not handled), then gives up as configured', async () => {
    let calls = 0;
    const tooMany: HttpResponse = { status: 429, headers: { 'retry-after': '0' }, body: 'slow down' };
    const http = fakeHttp(
        () => (++calls <= 2 ? tooMany : json(201, { id: 'ok' })),
        () => 0,
    );
    const one = (config: Record<string, unknown>) => {
        const wf = flow(config);
        (wf.nodes[1]!.config as { rows: string[][] }).rows = [['1', 'Production']];
        return wf;
    };
    const r = await flowRunner(one(POST_SECTOR), { mode: 'execution', id: 'r429', evaluate, http: http.send, secrets: SECRETS });
    expect(r.status).toBe('completed');
    expect(http.requests).toHaveLength(3);
    const node = nodeOf(r);
    expect(node.outputSample['out-0'][0]!.response).toMatchObject({ status: 201 });
    expect(node.logs.filter(l => l.level === 'warning').map(l => l.message)).toEqual([
        'POST ***/sectors?source=crm → 429: retry 1 of 3 in 0.0 s.',
        'POST ***/sectors?source=crm → 429: retry 2 of 3 in 0.0 s.',
    ]);

    // retries 0: the 429 is the answer; a 503 is retried only when asked
    calls = 0;
    const off = fakeHttp(
        () => tooMany,
        () => 0,
    );
    const none = await flowRunner(one({ ...POST_SECTOR, retries: 0 }), {
        mode: 'execution',
        id: 'r0',
        evaluate,
        http: off.send,
        secrets: SECRETS,
    });
    expect(off.requests).toHaveLength(1);
    expect(nodeOf(none).status).toBe('with-errors');
    const unavailable: HttpResponse = { status: 503, headers: { 'retry-after': '0' }, body: '' };
    const busy = fakeHttp(
        () => unavailable,
        () => 0,
    );
    await flowRunner(one({ ...POST_SECTOR, retries: 2 }), { mode: 'execution', id: 'r503a', evaluate, http: busy.send, secrets: SECRETS });
    expect(busy.requests).toHaveLength(1);
    const busy2 = fakeHttp(
        () => unavailable,
        () => 0,
    );
    await flowRunner(one({ ...POST_SECTOR, retries: 2, retryOn503: true }), {
        mode: 'execution',
        id: 'r503b',
        evaluate,
        http: busy2.send,
        secrets: SECRETS,
    });
    expect(busy2.requests).toHaveLength(3);

    // a Retry-After longer than the longest wait: not waited for
    const later = fakeHttp(
        () => ({ status: 429, headers: { 'retry-after': '3600' }, body: '' }),
        () => 0,
    );
    const gaveUp = await flowRunner(one({ ...POST_SECTOR, maxRetryWaitS: 5 }), {
        mode: 'execution',
        id: 'rlong',
        evaluate,
        http: later.send,
        secrets: SECRETS,
    });
    expect(later.requests).toHaveLength(1);
    expect(nodeOf(gaveUp).logs.some(l => l.message.includes('is longer than the longest wait (5 s): not retried'))).toBe(true);
});

test('HTTP Request: stopping the run ends a retry wait at once', async () => {
    const http = fakeHttp(
        () => ({ status: 429, headers: { 'retry-after': '30' }, body: '' }),
        () => 0,
    );
    const control = new AbortController();
    setTimeout(() => control.abort(), 50);
    const t0 = performance.now();
    const r = await flowRunner(flow({ ...POST_SECTOR, onError: 'throw' }), {
        mode: 'execution',
        id: 'rstop',
        evaluate,
        http: http.send,
        secrets: SECRETS,
        signal: control.signal,
    });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(r.status).toBe('failed');
});
