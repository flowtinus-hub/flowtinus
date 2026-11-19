import { z } from 'zod';
import { currentFlow } from '#features/git/branch-read';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { pinsOf, removePins, setPin, type Pinned, type Pins } from './pins';

const nodeId = z.string().min(1).max(200);
/** envelopes per output port */
const pinned = z.record(z.string().min(1), z.array(z.record(z.string(), z.unknown())));

export const GetPinsQuery = z.object({ id: z.uuid('Invalid') });
export const SetPinCommand = z.object({ id: z.uuid('Invalid'), nodeId, pinned });
export const UnpinCommand = z.object({ id: z.uuid('Invalid'), nodeId });

/** the asking user's pins on the flow, by node */
export class GetPinsHandler implements UseCaseHandler<{ pins: Pins }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ pins: Pins }>> {
        const parsed = validate(GetPinsQuery, input);
        if (!parsed.ok) {
            return parsed;
        }

        const flow = await currentFlow(ctx, parsed.value.id);
        return flow ? success({ pins: await pinsOf(ctx.db, ctx.workspaceId, ctx.userId, flow.id) }) : fail('not-found', 'Flow not found.');
    }
}

export class SetPinHandler implements UseCaseHandler<{ nodeId: string }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ nodeId: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(SetPinCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const flow = await currentFlow(ctx, parsed.value.id);
        return flow ? setPin(ctx, flow.id, parsed.value.nodeId, parsed.value.pinned as Pinned) : fail('not-found', 'Flow not found.');
    }
}

export class UnpinHandler implements UseCaseHandler<{ unpinned: string[] }> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ unpinned: string[] }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }

        const parsed = validate(UnpinCommand, input);
        if (!parsed.ok) {
            return parsed;
        }

        const flow = await currentFlow(ctx, parsed.value.id);
        return flow ? success({ unpinned: await removePins(ctx, flow.id, [parsed.value.nodeId]) }) : fail('not-found', 'Flow not found.');
    }
}
