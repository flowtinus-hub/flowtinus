import { COMPONENT_TYPE } from '#components/component-types';
import { API_CONNECTION_TYPES, connectionIssues, connectionSettings, type ConnectionUse } from '../../connections/connection-access';
import { runConnection } from '../run-connection';
import { RESPONSE_HEADER_MODES, responseHeaders, type ResponseHeaderMode } from '../../connections/sensitive-headers';
import { withKey } from '#envelope/envelope-data';
import { toError } from '#errors/normalize-error';
import type { ComponentLogic } from '#types/component-logic.type';
import type { Envelope } from '#types/envelope.type';
import type { ExpressionField } from '#types/expression-field.type';
import type { HttpResponse } from '#types/http-response.type';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export type HttpPair = ExpressionField & { name: string };

export const HTTP_BODY_TYPES = ['raw', 'multipart'] as const;
export type HttpBodyType = (typeof HTTP_BODY_TYPES)[number];
export type HttpFormPart = ExpressionField & { name: string; filename?: Partial<ExpressionField>; contentType?: string };

export const DEFAULT_HTTP_TIMEOUT_S = 30;
/** retries on 429 by default: the server did not handle the request, sending it again is safe whatever the method */
export const DEFAULT_HTTP_RETRIES = 3;
export const MAX_HTTP_RETRIES = 10;
export const DEFAULT_RETRY_WAIT_S = 60;
export const MAX_HTTP_CONCURRENCY = 20;
const ERROR_EXCERPT = 300;

export function httpConfig(config: Record<string, unknown>) {
    const timeout = Math.round(Number(config.timeoutS ?? DEFAULT_HTTP_TIMEOUT_S));
    const concurrency = Math.round(Number(config.concurrency ?? 1));
    const field = (v: unknown, expression: boolean): ExpressionField => {
        const f = v as Partial<ExpressionField> | undefined;
        return {
            value: typeof f?.value === 'string' ? f.value : '',
            expression: typeof f?.expression === 'boolean' ? f.expression : expression,
        };
    };
    return {
        method: (HTTP_METHODS.includes(config.method as HttpMethod) ? config.method : 'GET') as HttpMethod,
        url: field(config.url, false),
        query: Array.isArray(config.query) ? (config.query as HttpPair[]) : [],
        headers: Array.isArray(config.headers) ? (config.headers as HttpPair[]) : [],
        body: field(config.body, true),
        bodyType: (HTTP_BODY_TYPES.includes(config.bodyType as HttpBodyType) ? config.bodyType : 'raw') as HttpBodyType,
        parts: Array.isArray(config.parts) ? (config.parts as HttpFormPart[]) : [],
        timeoutS: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_HTTP_TIMEOUT_S,
        concurrency: Number.isFinite(concurrency) ? Math.min(MAX_HTTP_CONCURRENCY, Math.max(1, concurrency)) : 1,
        failOnError: config.failOnError !== false,
        retries: Math.min(MAX_HTTP_RETRIES, Math.max(0, Math.round(Number(config.retries ?? DEFAULT_HTTP_RETRIES)) || 0)),
        retryOn503: config.retryOn503 === true,
        maxRetryWaitS: Math.max(1, Math.round(Number(config.maxRetryWaitS ?? DEFAULT_RETRY_WAIT_S)) || DEFAULT_RETRY_WAIT_S),
        responseHeaders: (RESPONSE_HEADER_MODES.includes(config.responseHeaders as ResponseHeaderMode)
            ? config.responseHeaders
            : 'safe') as ResponseHeaderMode,
    };
}

export const httpWrites = (config: Record<string, unknown>) => httpConfig(config).method !== 'GET';

/** a name or file name inside a part's Content-Disposition: quoted, so no quote or line break of its own */
const dispositionValue = (text: string) => `"${text.replace(/[\r\n]/g, ' ').replace(/"/g, '%22')}"`;

/** A multipart/form-data body (RFC 7578) as text, so a binary file does not fit in it. */
export function multipartBody(
    parts: { name: string; content: unknown; filename?: string; contentType?: string }[],
    boundary = `----flowtinus${crypto.randomUUID().replace(/-/g, '')}`,
): { body: string; contentType: string } {
    const lines: string[] = [];
    for (const part of parts) {
        const isObject = part.content !== null && typeof part.content === 'object';
        const content =
            part.content === undefined || part.content === null ? '' : isObject ? JSON.stringify(part.content) : String(part.content);
        const type = part.contentType?.trim() || (isObject ? 'application/json' : part.filename ? 'application/octet-stream' : '');
        lines.push(`--${boundary}`);
        lines.push(
            `Content-Disposition: form-data; name=${dispositionValue(part.name)}${part.filename ? `; filename=${dispositionValue(part.filename)}` : ''}`,
        );
        if (type) {
            lines.push(`Content-Type: ${type}`);
        }
        lines.push('', content);
    }
    lines.push(`--${boundary}--`, '');
    return { body: lines.join('\r\n'), contentType: `multipart/form-data; boundary=${boundary}` };
}

function responseBody(response: HttpResponse): unknown {
    if (!/json/i.test(response.headers['content-type'] ?? '') || response.body === '') {
        return response.body;
    }
    try {
        return JSON.parse(response.body);
    } catch {
        return response.body;
    }
}

type Outcome = { doc: Envelope; error?: Error; response?: HttpResponse | null; request?: { method: string; url: string } };

export const httpRequest: ComponentLogic = {
    type: COMPONENT_TYPE.httpRequest,
    label: 'HTTP Request',
    category: 'api',
    description:
        'Sends one request per envelope (method, URL, query params, headers and body are values or expressions on it; $SECRETS works; the body as it is, or a multipart form of fields and text files) and the envelope goes on with {status, headers, body} in its output key (default `response`; a JSON body parsed). Authentication from an API connection of the workspace or the component. POST, PUT, PATCH and DELETE write: a test run does not send them and the envelope goes on with {notSent: true}.',
    example: {
        connection: '',
        method: 'POST',
        url: { value: 'https://api.example.com/orders', expression: false },
        headers: [{ name: 'Accept', value: 'application/json', expression: false }],
        body: { value: '$DATA', expression: true },
        timeoutS: 30,
        concurrency: 4,
        failOnError: true,
    },
    inputs: 1,
    outputs: 1,
    usesOverride: true,
    defaultOutputKey: 'response',
    sideEffects: httpWrites,
    settings: [
        ...connectionSettings('http-client', API_CONNECTION_TYPES, 'Connection', true),
        { key: 'method', label: 'Method', kind: 'select', default: 'GET', options: HTTP_METHODS.map(m => ({ value: m, label: m })) },
        {
            key: 'url',
            label: 'URL',
            kind: 'value',
            required: true,
            default: { value: '', expression: false },
            placeholder: 'https://api.example.com/orders',
        },
        {
            key: 'query',
            label: 'Query params',
            kind: 'list',
            itemLabel: 'param',
            item: [
                { key: 'name', label: 'Name', kind: 'text', required: true },
                { key: 'value', label: 'Value', kind: 'value', spread: true, default: { value: '', expression: false } },
            ],
        },
        {
            key: 'headers',
            label: 'Headers',
            kind: 'list',
            itemLabel: 'header',
            item: [
                { key: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'Accept' },
                { key: 'value', label: 'Value', kind: 'value', spread: true, default: { value: '', expression: false } },
            ],
        },
        {
            key: 'bodyType',
            label: 'Body type',
            kind: 'select',
            default: 'raw',
            options: [
                { value: 'raw', label: 'Raw (text, or JSON for an object)' },
                { value: 'multipart', label: 'Multipart form (form-data)' },
            ],
            when: { key: 'method', values: ['POST', 'PUT', 'PATCH', 'DELETE'] },
        },
        {
            key: 'body',
            label: 'Body',
            kind: 'value',
            default: { value: '', expression: true },
            placeholder: '$DATA',
            when: [
                { key: 'method', values: ['POST', 'PUT', 'PATCH', 'DELETE'] },
                { key: 'bodyType', values: ['raw'] },
            ],
        },
        {
            key: 'parts',
            label: 'Form parts',
            kind: 'list',
            itemLabel: 'part',
            description:
                'Each part of the multipart/form-data body: a field, or a file when it has a file name. The content is text (an object goes as JSON); the Content-Type header with its boundary is set for you.',
            item: [
                { key: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'file' },
                {
                    key: 'value',
                    label: 'Content',
                    kind: 'value',
                    spread: true,
                    default: { value: '', expression: true },
                    placeholder: '$csv',
                },
                { key: 'filename', label: 'File name', kind: 'value', default: { value: '', expression: false }, placeholder: 'users.csv' },
                { key: 'contentType', label: 'Content type', kind: 'text', placeholder: 'text/csv' },
            ],
            when: [
                { key: 'method', values: ['POST', 'PUT', 'PATCH', 'DELETE'] },
                { key: 'bodyType', values: ['multipart'] },
            ],
        },
        { key: 'timeoutS', label: 'Timeout (seconds)', kind: 'number', default: DEFAULT_HTTP_TIMEOUT_S, min: 1 },
        { key: 'concurrency', label: 'Requests at once', kind: 'number', default: 1, min: 1, max: MAX_HTTP_CONCURRENCY },
        { key: 'failOnError', label: 'Fail on non-2xx', kind: 'boolean', default: true },
        {
            key: 'retries',
            label: 'Retries on 429',
            kind: 'number',
            default: DEFAULT_HTTP_RETRIES,
            min: 0,
            max: MAX_HTTP_RETRIES,
            description:
                "On 429 (Too Many Requests) the request is sent again after the server's Retry-After, or a backoff of 1 s, 2 s, 4 s... (with jitter). 0: never.",
        },
        {
            key: 'retryOn503',
            label: 'Also retry on 503',
            kind: 'boolean',
            default: false,
            description: 'Retries on 503 (Service Unavailable) too: only for requests that can be sent twice (a GET, an idempotent PUT).',
        },
        {
            key: 'maxRetryWaitS',
            label: 'Longest wait before a retry (seconds)',
            kind: 'number',
            default: DEFAULT_RETRY_WAIT_S,
            min: 1,
            description: 'A Retry-After longer than this is not waited for: the answer goes on as it came (an error with Fail on non-2xx).',
        },
        {
            key: 'responseHeaders',
            label: 'Response headers',
            kind: 'select',
            default: 'safe',
            options: [
                { value: 'safe', label: 'Safe (credentials hidden)' },
                { value: 'none', label: 'None' },
                { value: 'all', label: 'All (unsafe: cookies and tokens kept)' },
            ],
        },
    ],

    validate(config) {
        const { url, query, headers, method, bodyType, parts } = httpConfig(config);
        const issues: string[] = [...connectionIssues('http-client', config)];
        if (!url.value.trim()) {
            issues.push('has no URL.');
        } else if (!url.expression && !/^https?:\/\//i.test(url.value.trim())) {
            issues.push('has a URL that does not start with http:// or https://.');
        }
        query.forEach((p, i) => p.name?.trim() || issues.push(`query param ${i + 1} has no name.`));
        headers.forEach((h, i) => {
            if (!h.name?.trim()) {
                issues.push(`header ${i + 1} has no name.`);
            } else if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(h.name.trim())) {
                issues.push(`header "${h.name}" is not a valid header name.`);
            }
        });
        if (method !== 'GET' && bodyType === 'multipart') {
            if (parts.length === 0) {
                issues.push('has a multipart body without parts.');
            }
            parts.forEach((p, i) => p.name?.trim() || issues.push(`form part ${i + 1} has no name.`));
        }
        return issues;
    },

    async *execute(inputs, config, ctx) {
        const {
            method,
            url,
            query,
            headers,
            body,
            bodyType,
            parts,
            timeoutS,
            concurrency,
            failOnError,
            responseHeaders: headerMode,
            retries,
            retryOn503,
            maxRetryWaitS,
        } = httpConfig(config);
        const retry = retries > 0 ? { retries, statuses: retryOn503 ? [429, 503] : [429], maxWaitMs: maxRetryWaitS * 1000 } : undefined;
        const auth: ConnectionUse = runConnection('http-client', config, ctx);
        const key = ctx.node.outputKey || 'response';
        const counts = { ok: 0, client: 0, server: 0, other: 0, errors: 0, notSent: 0 };
        const t0 = performance.now();

        /** builds and sends the request of an envelope; never rejects (an error is part of the outcome) */
        const send = async (doc: Envelope): Promise<Outcome> => {
            try {
                const value = (f: ExpressionField) => ctx.fieldValue(f, doc);
                let target = String(value(url) ?? '').trim();
                if (!/^https?:\/\//i.test(target)) {
                    throw new Error(`The URL "${ctx.mask(target)}" does not start with http:// or https://.`);
                }
                const params = query
                    .filter(p => p.name?.trim())
                    .map(p => {
                        const v = value(p);
                        return `${encodeURIComponent(p.name.trim())}=${encodeURIComponent(v === undefined || v === null ? '' : String(v))}`;
                    });
                if (params.length) {
                    target += (target.includes('?') ? '&' : '?') + params.join('&');
                }
                const sentHeaders: Record<string, string> = {};
                for (const h of headers) {
                    if (h.name?.trim()) {
                        sentHeaders[h.name.trim()] = String(value(h) ?? '');
                    }
                }
                let sentBody: string | undefined;
                if (method !== 'GET' && bodyType === 'multipart') {
                    const form = multipartBody(
                        parts
                            .filter(p => p.name?.trim())
                            .map(p => {
                                const named = p.filename?.value
                                    ? value({ value: p.filename.value, expression: p.filename.expression === true })
                                    : undefined;
                                const filename = named === undefined || named === null ? '' : String(named).trim();
                                return {
                                    name: p.name.trim(),
                                    content: value(p),
                                    ...(filename ? { filename } : {}),
                                    ...(p.contentType?.trim() ? { contentType: p.contentType.trim() } : {}),
                                };
                            }),
                    );
                    // the boundary is in the content type: one the headers set would not match the body
                    for (const name of Object.keys(sentHeaders).filter(h => h.toLowerCase() === 'content-type')) {
                        delete sentHeaders[name];
                    }
                    sentHeaders['content-type'] = form.contentType;
                    sentBody = form.body;
                } else if (method !== 'GET' && body.value.trim()) {
                    const content = value(body);
                    if (content !== undefined && content !== null) {
                        if (typeof content === 'string') {
                            sentBody = content;
                        } else {
                            sentBody = JSON.stringify(content);
                            if (!Object.keys(sentHeaders).some(h => h.toLowerCase() === 'content-type')) {
                                sentHeaders['content-type'] = 'application/json';
                            }
                        }
                    }
                }
                const response = await ctx.sendHttp({
                    method,
                    url: target,
                    headers: sentHeaders,
                    body: sentBody,
                    timeoutMs: timeoutS * 1000,
                    auth,
                    ...(retry ? { retry } : {}),
                });
                return { doc, response, request: { method, url: target } };
            } catch (e) {
                return { doc, error: toError(e) };
            }
        };

        const pending: Promise<Outcome>[] = [];
        async function* settle(outcome: Promise<Outcome>) {
            const { doc, error, response, request } = await ctx.wait(outcome);
            if (error) {
                counts.errors += 1;
                yield { error, doc };
                return;
            }
            if (!response || !request) {
                counts.notSent += 1;
                yield { port: 'out-0', doc: withKey(doc, key, { notSent: true }, ctx.node.override) };
                return;
            }
            const s = response.status;
            if (s >= 200 && s < 300) {
                counts.ok += 1;
            } else if (s >= 400 && s < 500) {
                counts.client += 1;
            } else if (s >= 500) {
                counts.server += 1;
            } else {
                counts.other += 1;
            }
            if (failOnError && (s < 200 || s >= 300)) {
                const excerpt = response.body.length > ERROR_EXCERPT ? `${response.body.slice(0, ERROR_EXCERPT)}…` : response.body;
                yield {
                    error: Object.assign(
                        new Error(ctx.mask(`HTTP ${s} on ${request.method} ${request.url}${excerpt ? `: ${excerpt}` : ''}`)),
                        { name: 'HttpError' },
                    ),
                    doc,
                };
                return;
            }
            yield {
                port: 'out-0',
                doc: withKey(
                    doc,
                    key,
                    { status: s, headers: responseHeaders(response.headers, headerMode), body: responseBody(response) },
                    ctx.node.override,
                ),
            };
        }

        for await (const doc of inputs['in-0'] ?? []) {
            pending.push(send(doc));
            if (pending.length >= concurrency) {
                yield* settle(pending.shift()!);
            }
        }
        while (pending.length) {
            yield* settle(pending.shift()!);
        }

        const total = counts.ok + counts.client + counts.server + counts.other + counts.errors + counts.notSent;
        if (counts.notSent && counts.notSent === total) {
            ctx.log('debug', `${total} ${method} request(s) prepared, none sent (test run).`);
        } else {
            ctx.log(
                'debug',
                `${total} request(s): 2xx ${counts.ok}, 4xx ${counts.client}, 5xx ${counts.server}${counts.other ? `, other ${counts.other}` : ''}, errors ${counts.errors}, in ${Math.round(performance.now() - t0)} ms.`,
            );
        }
    },
};
