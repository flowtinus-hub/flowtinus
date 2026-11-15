import { z } from 'zod';
import type { ConnectionServer } from '@flowtinus/core';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { ConnectionRepository } from '../connection-store';
import { LIVE_TESTS, testProfile, type ConnectionTests, type TestConnectionResponse } from './test-profile';

export const TestConnectionCommand = z.object({ id: z.uuid('Invalid') });

export type { TestConnectionResponse };

export class TestConnectionHandler implements UseCaseHandler<TestConnectionResponse> {
    constructor(private readonly tests: ConnectionTests = LIVE_TESTS) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<TestConnectionResponse>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(TestConnectionCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const profile = await new ConnectionRepository(ctx.db, ctx.workspaceId).findById(parsed.value.id);
        if (!profile) {
            return fail('not-found', 'Connection not found.');
        }

        const tested = await testProfile(ctx, this.tests, profile);
        if (tested.ok && tested.value.server) {
            const server: ConnectionServer = { ...tested.value.server, testedAt: new Date().toISOString() };
            await ctx.db.query('UPDATE connections SET server = $1::text::jsonb WHERE id = $2 AND workspace_id = $3', [
                JSON.stringify(server),
                profile.id,
                ctx.workspaceId,
            ]);
        }

        return tested;
    }
}
