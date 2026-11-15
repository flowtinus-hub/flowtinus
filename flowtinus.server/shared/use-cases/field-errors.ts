import { fail, type UseCaseResult } from './use-case-result';

export function fieldErrors(errors: Record<string, string | undefined>): UseCaseResult<never> | null {
    const fields = Object.fromEntries(Object.entries(errors).filter(([, error]) => error !== undefined)) as Record<string, string>;
    if (Object.keys(fields).length === 0) {
        return null;
    }

    return fail(Object.values(fields).includes('Already in use') ? 'conflict' : 'validation', 'The request has invalid fields.', fields);
}
