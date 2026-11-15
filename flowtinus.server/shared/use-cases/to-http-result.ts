import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { UseCaseErrorCode, UseCaseResult } from './use-case-result';

const STATUS: Record<UseCaseErrorCode, ContentfulStatusCode> = {
    validation: 400,
    forbidden: 403,
    'not-found': 404,
    conflict: 409,
    unavailable: 502,
};

export function toHttpResult<T>(c: Context, result: UseCaseResult<T>, successStatus: ContentfulStatusCode = 200) {
    if (result.ok) {
        return c.json(result.value ?? null, successStatus);
    }

    return c.json({ error: result.error }, STATUS[result.error.code]);
}
