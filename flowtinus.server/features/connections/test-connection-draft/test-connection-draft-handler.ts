import { z } from 'zod';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import type { UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { LIVE_TESTS, testProfile, type ConnectionTests, type TestConnectionResponse } from '../test-connection/test-profile';

export const TestConnectionDraftCommand = z.object({
    type: z.string(),
    config: z.record(z.string(), z.string()),
    newSecrets: z.array(z.object({ name: z.string().trim(), value: z.string() })).default([]),
});

export class TestConnectionDraftHandler implements UseCaseHandler<TestConnectionResponse> {
    constructor(private readonly tests: ConnectionTests = LIVE_TESTS) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<TestConnectionResponse>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(TestConnectionDraftCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const { newSecrets, ...fields } = parsed.value;
        return testProfile(ctx, this.tests, fields, newSecrets);
    }
}
