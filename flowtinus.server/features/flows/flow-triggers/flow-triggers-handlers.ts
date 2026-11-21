import { z } from 'zod';
import type { RepoSchedule, RepoTriggers, RepoWebhook } from '@flowtinus/core';
import { activeFlow } from '#features/deployments/deployments';
import { branchFlow, workBranch } from '#features/git/branch-read';
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
        const git = await gitBranch(ctx.db, ctx.workspaceId);
        if (!git) {
            return fail('conflict', GIT_OFF);
        }

        const branch = await workBranch(ctx);
        if (branch) {
            const found = branchFlow(branch, parsed.value.id);
            if (!found) {
                return flowNotFound();
            }
            const reason = await readOnlyReason(() => refuseReadOnly(ctx, branch));
            return success({
                file: reason ? { editable: false, readOnly: reason } : { editable: true },
                ...found.triggers,
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

async function changeFile(ctx: UseCaseContext, flowId: string, change: Change, missing: string): Promise<UseCaseResult<RepoTriggers>> {
    const git = await gitBranch(ctx.db, ctx.workspaceId);
    if (!git) {
        return fail('conflict', GIT_OFF);
    }

    const branch = await workBranch(ctx);
    if (branch) {
        const found = branchFlow(branch, flowId);
        if (!found) {
            return flowNotFound();
        }
        const next = change(found.triggers);
        if (!next) {
            return fail('not-found', missing);
        }
        const saved = await saveDraftOnBranch(ctx, branch, { id: flowId, revision: found.revision, flow: found.file, triggers: next });
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

const ScheduleCommand = z.object({ id: z.uuid('Invalid'), scheduleId: z.uuid('Invalid').optional(), fields: FileScheduleInput });

const FileWebhookInput = WebhookFieldsInput.omit({ enabled: true });

const WebhookCommand = z.object({ id: z.uuid('Invalid'), webhookId: z.uuid('Invalid').optional(), fields: FileWebhookInput });

const toSchedule = (id: string, fields: z.infer<typeof FileScheduleInput>): RepoSchedule => ({
    id,
    cron: fields.cron,
    timezone: fields.timezone,
    misfire: fields.misfire,
    parameters: fields.parameters,
    ...(fields.input === undefined || fields.input === null ? {} : { input: fields.input }),
});

export class SaveFileScheduleHandler implements UseCaseHandler<RepoSchedule> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<RepoSchedule>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(ScheduleCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        const { id: flowId, scheduleId, fields } = parsed.value;
        const schedule = toSchedule(scheduleId ?? crypto.randomUUID(), fields);
        const saved = await changeFile(
            ctx,
            flowId,
            triggers => {
                const schedules = scheduleId ? replaced(triggers.schedules, scheduleId, schedule) : [...triggers.schedules, schedule];
                return schedules && { ...triggers, schedules };
            },
            'Schedule not found.',
        );
        return saved.ok ? success(schedule) : saved;
    }
}

export class SaveFileWebhookHandler implements UseCaseHandler<RepoWebhook> {
    async handle(input: unknown, ctx: UseCaseContext): Promise<UseCaseResult<RepoWebhook>> {
        const denied = requireRole(ctx, 'editor');
        if (denied) {
            return denied;
        }
        const parsed = validate(WebhookCommand, input);
        if (!parsed.ok) {
            return parsed;
        }
        const { id: flowId, webhookId, fields } = parsed.value;
        const webhook: RepoWebhook = { id: webhookId ?? crypto.randomUUID(), name: fields.name, response: fields.response };
        const saved = await changeFile(
            ctx,
            flowId,
            triggers => {
                const webhooks = webhookId ? replaced(triggers.webhooks, webhookId, webhook) : [...triggers.webhooks, webhook];
                return webhooks && { ...triggers, webhooks };
            },
            'Webhook not found.',
        );
        return saved.ok ? success(webhook) : saved;
    }
}

const RemoveCommand = z.object({ id: z.uuid('Invalid'), triggerId: z.uuid('Invalid') });

export class RemoveFileTriggerHandler implements UseCaseHandler<{ id: string }> {
    constructor(private readonly kind: 'schedules' | 'webhooks') {}

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
        const removed = await changeFile(
            ctx,
            flowId,
            triggers => {
                const kept = replaced<{ id: string }>(triggers[this.kind], triggerId, null);
                return kept && { ...triggers, [this.kind]: kept };
            },
            this.kind === 'schedules' ? 'Schedule not found.' : 'Webhook not found.',
        );
        return removed.ok ? success({ id: triggerId }) : removed;
    }
}
