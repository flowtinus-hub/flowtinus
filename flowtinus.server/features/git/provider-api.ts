import { ProviderError } from './provider-adapter';

const TIMEOUT_MS = 10_000;

export const PAGE = 100;

type ErrorBody = { message?: unknown; error?: unknown; error_description?: unknown; errors?: unknown };

function jsonOf(text: string): ErrorBody {
    try {
        return JSON.parse(text) ?? {};
    } catch {
        return {};
    }
}

const detailsOf = (errors: unknown): string[] =>
    Array.isArray(errors) ? errors.map(e => e?.message).filter((m): m is string => typeof m === 'string') : [];

async function errorOf(response: Response): Promise<string> {
    const text = await response.text().catch(() => '');
    const body = jsonOf(text);
    const message = body.message ?? body.error_description ?? body.error;
    if (message !== undefined) {
        return [typeof message === 'string' ? message : JSON.stringify(message), ...detailsOf(body.errors)].join(': ');
    }
    return text.trim().slice(0, 200) || `${response.status} ${response.statusText}`;
}

/** a request to a provider's API: no answer, or one that is not ok, throws a ProviderError */
export async function callProvider(url: string, method: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(url, {
            method,
            headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'manual',
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (e) {
        throw new ProviderError((e as Error).message, null);
    }
    if (!response.ok) {
        throw new ProviderError(await errorOf(response), response.status);
    }
    return response;
}
