import type { Context } from 'hono';

export const jsonBody = (c: Context) => c.req.json<unknown>().catch(() => undefined);

export async function bodyWith(c: Context, fields: Record<string, string>): Promise<unknown> {
    const body = await jsonBody(c);
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? { ...body, ...fields } : body;
}
