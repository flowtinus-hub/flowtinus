import type { UseCaseError, UseCaseErrorCode } from './use-case-result';

export class UseCaseFailure extends Error {
    readonly error: UseCaseError;

    constructor(code: UseCaseErrorCode, message: string, fields?: Record<string, string>) {
        super(message);
        this.error = fields ? { code, message, fields } : { code, message };
    }
}
