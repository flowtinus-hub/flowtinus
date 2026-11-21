import { z } from 'zod';
import type { RepoSchedule, RepoTriggers, RepoWebhook, TriggerKind } from '@flowtinus/core';
import { activeFlow } from '#features/deployments/deployments';
import { branchFlow, workBranch, type BranchFlow, type WorkBranch } from '#features/git/branch-read';
import { saveDraftOnBranch } from '#features/git/branch-edits';
import { refuseReadOnly } from '#features/git/branch-write';
import { gitBranch } from '#features/git/git-config';
import { FileScheduleInput } from '#features/schedules/schedule-command';
import { listFlowSchedules, type ScheduleView } from '#features/schedules/schedules';
import { listFlowWebhooks, WebhookFieldsInput, type WebhookView } from '#features/webhooks/webhooks';
import type { UseCaseContext } from '#shared/use-cases/use-case-context';
import { UseCaseFailure } from '#shared/use-cases/use-case-failure';
import { requireRole } from '#shared/use-cases/require-role';
import type { UseCaseHandler } from '#shared/use-cases/use-case-handler';
import { fail, success, type UseCaseResult } from '#shared/use-cases/use-case-result';
import { validate } from '#shared/use-cases/validate';
import { draftTriggers, loadDraft, writeDraft } from '../flow-draft';

export type FlowTriggersView = {
    file: { editable: boolean; offersBranch?: true; readOnly?: string };
    schedules: RepoSchedule[];
    webhooks: RepoWebhook[];
    environment: { schedules: ScheduleView[]; webhooks: WebhookView[] } | null;
};

export const PROTECTED_TRIGGERS = "This server's environment is protected: the triggers in the flow's file are read only here.";

const GIT_OFF = "Git is off in this workspace: the flow's schedules and webhooks are not in its file.";

const flowNotFound = () => fail('not-found', 'Flow not found.');

const FILE_LISTS = {
    schedule: { list: 'schedules', notFound: 'Schedule not found.' },
    webhook: { list: 'webhooks', notFound: 'Webhook not found.' },
} as const satisfies Record<TriggerKind, { list: keyof RepoTriggers; notFound: string }>;

type GitPlace = { git: NonNullable<Awaited<ReturnType<typeof gitBranch>>>; work: { branch: WorkBranch; flow: BranchFlow } | null };

async function gitPlace(ctx: UseCaseContext, flowId: string): Promise<UseCaseResult<GitPlace>> {
    const git = await gitBranch(ctx.db, ctx.workspaceId);
    if (!git) {
        return fail('conflict', GIT_OFF);
    }
    const branch = await workBranch(ctx);
    if (!branch) {
        return success({ git, work: null });
    }
    const flow = branchFlow(branch, flowId);
    return flow ? success({ git, work: { branch, flow } }) : flowNotFound();
}

async function readOnlyReason(run: () => Promise<void>): Promise<string | null> {
    try {
        await run();
        return null;
    } catch (e) {
        if (e instanceof UseCaseFailure) {
            return e.message;
        }
        throw e;
    }
}

export class GetFlowTriggersHandler implements UseCaseHandler<FlowTriggersView> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<FlowTriggersView>> {
        const parsed = validate(z.object({ id: z.uuid('Invalid') }), input);
        if (!parsed.ok) {
            return parsed;
        }
        const place = await gitPlace(ctx, parsed.value.id);
        if (!place.ok) {
            return place;
        }
        const { git, work } = place.value;
        if (work) {
            const reason = await readOnlyReason(() => refuseReadOnly(ctx, work.branch));
            return success({
                file: reason ? { editable: false, readOnly: reason } : { editable: true },
                ...work.flow.triggers,
                environment: null,
            });
        }

        const row = await activeFlow(ctx, parsed.value.id);
        if (!row) {
            return flowNotFound();
        }
        const [triggers, schedules, webhooks] = await Promise.all([
            draftTriggers(ctx.db, ctx.workspaceId, row),
            listFlowSchedules(ctx.db, ctx.workspaceId, row.id),
            listFlowWebhooks(ctx.db, ctx.workspaceId, row.id),
        ]);
        const file =
            git.mode === 'protected'
                ? { editable: false, readOnly: PROTECTED_TRIGGERS }
                : git.mode === 'pull-request'
                  ? { editable: false, offersBranch: true as const }
                  : { editable: true };
        return success({ file, ...triggers, environment: { schedules, webhooks } });
    }
}

type Change = (triggers: RepoTriggers) => RepoTriggers | null;

async function changeFile(ctx: UseCaseContext, flowId: string, change: Change, kind: TriggerKind): Promise<UseCaseResult<RepoTriggers>> {
    const missing = FILE_LISTS[kind].notFound;
    const place = await gitPlace(ctx, flowId);
    if (!place.ok) {
        return place;
    }
    const { git, work } = place.value;
    if (work) {
        const next = change(work.flow.triggers);
        if (!next) {
            return fail('not-found', missing);
        }
        const saved = await saveDraftOnBranch(ctx, work.branch, {
            id: flowId,
            revision: work.flow.revision,
            flow: work.flow.file,
            triggers: next,
        });
        return saved.ok ? success(next) : saved;
    }

    if (git.mode === 'protected') {
        return fail('conflict', PROTECTED_TRIGGERS);
    }
    const row = await activeFlow(ctx, flowId);
    if (!row) {
        return flowNotFound();
    }
    const [draft, triggers] = await Promise.all([loadDraft(ctx.db, ctx.workspaceId, row), draftTriggers(ctx.db, ctx.workspaceId, row)]);
    const next = change(triggers);
    if (!next) {
        return fail('not-found', missing);
    }
    const saved = await ctx.db.transaction(db =>
        writeDraft(db, ctx.workspaceId, row, draft.flow, ctx.userId, draft.revision, { triggers: next }),
    );
    return saved === null ? fail('conflict', 'This flow was changed elsewhere. Reload it to see the latest version.') : success(next);
}

const replaced = <T extends { id: string }>(items: T[], id: string, item: T | null): T[] | null =>
    items.some(i => i.id === id) ? items.flatMap(i => (i.id !== id ? [i] : item ? [item] : [])) : null;

const FileWebhookInput = WebhookFieldsInput.omit({ enabled: true });

const toSchedule = (id: string, fields: z.infer<typeof FileScheduleInput>): RepoSchedule => ({
    id,
    cron: fields.cron,
    timezone: fields.timezone,
    misfire: fields.misfire,
    parameters: fields.parameters,
    ...(fields.input === undefined || fields.input === null ? {} : { input: fields.input }),
});

const toWebhook = (id: string, fields: z.infer<typeof FileWebhookInput>): RepoWebhook => ({
    id,
    name: fields.name,
    response: fields.response,
});

const fileCommand =
    <S extends z.ZodType, T>(fields: S, make: (id: string, fields: z.output<S>) => T) =>
    (input: unknown): UseCaseResult<{ flowId: string; triggerId?: string; trigger: T }> => {
        const parsed = validate(z.object({ id: z.uuid('Invalid'), triggerId: z.uuid('Invalid').optional(), fields }), input);
        if (!parsed.ok) {
            return parsed;
        }
        const { id, triggerId, fields: values } = parsed.value as { id: string; triggerId?: string; fields: z.output<S> };
        return success({ flowId: id, triggerId, trigger: make(triggerId ?? crypto.randomUUID(), values) });
    };

const FILE_COMMANDS = {
    schedule: fileCommand(FileScheduleInput, toSchedule),
    webhook: fileCommand(FileWebhookInput, toWebhook),
};

export class SaveFileTriggerHandler implements UseCaseHandler<RepoSchedule | RepoWebhook> {
    constructor(private readonly kind: TriggerKind) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<RepoSchedule | RepoWebhook>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = FILE_COMMANDS[this.kind](input);
        if (!parsed.ok) {
            return parsed;
        }
        const { flowId, triggerId, trigger } = parsed.value;
        const { list } = FILE_LISTS[this.kind];
        const saved = await changeFile(
            ctx,
            flowId,
            triggers => {
                const items = triggerId ? replaced<{ id: string }>(triggers[list], triggerId, trigger) : [...triggers[list], trigger];
                return items && { ...triggers, [list]: items };
            },
            this.kind,
        );
        return saved.ok ? success(trigger) : saved;
    }
}

const RemoveCommand = z.object({ id: z.uuid('Invalid'), triggerId: z.uuid('Invalid') });

export class RemoveFileTriggerHandler implements UseCaseHandler<{ id: string }> {
    constructor(private readonly kind: TriggerKind) {}

    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<{ id: string }>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(RemoveCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        const { id: flowId, triggerId } = parsed.value;
        const { list } = FILE_LISTS[this.kind];
        const removed = await changeFile(
            ctx,
            flowId,
            triggers => {
                const kept = replaced<{ id: string }>(triggers[list], triggerId, null);
                return kept && { ...triggers, [list]: kept };
            },
            this.kind,
        );
        return removed.ok ? success({ id: triggerId }) : removed;
    }
}
