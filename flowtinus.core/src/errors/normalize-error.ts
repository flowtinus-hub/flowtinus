export function toError(e: unknown): Error {
    if (e instanceof Error) {
        return e;
    }
    if (e && typeof e === 'object' && 'message' in e) {
        const cause = (e as { cause?: unknown }).cause;
        const error = new Error(String((e as { message: unknown }).message), cause !== undefined ? { cause } : undefined);
        error.name = 'name' in e ? String((e as { name: unknown }).name) : 'Error';
        return error;
    }
    return new Error(String(e));
}
