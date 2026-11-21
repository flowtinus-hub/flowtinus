import { useEffect, useState, type ReactNode } from 'react';
import { CalendarClock, KeyRound, LoaderCircle, Pencil, Plus, SlidersHorizontal, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { cronError } from '@flowtinus/core';
import type { ConfirmTarget } from '@/components/confirm-dialog';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { CHANGES_CHANGED, TRIGGERS_SWITCHED } from '@/data/git/git-api';
import { describeCron, MISFIRE_OPTIONS, timeZones, type Schedule } from '@/data/schedules/schedule';
import { switchSchedule } from '@/data/schedules/schedules-api';
import { getFlowTriggers, overrideSchedule, removeFileSchedule, removeFileWebhook, saveFileSchedule, saveFileWebhook, type FileSchedule, type FileWebhook, type FlowTriggers } from '@/data/triggers/flow-triggers-api';
import { WEBHOOK_RESPONSE_OPTIONS, webhookMethods, webhookUrl, type Webhook } from '@/data/webhooks/webhook';
import { regenerateToken, switchWebhook } from '@/data/webhooks/webhooks-api';
import type { ApiResult } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import { LAST_TONE, ScheduleForm, SELECT, type StartOf } from './schedules-menu';
import { ArrivedBadge, useTriggersChanged } from './use-triggers-changed';
import { callTone, serverOrigin, TokenDialog, TokenHint, WebhookForm } from './webhooks-menu';

export type TriggerWindowProps = {
    flowId: string;
    disabled: boolean;
    canEdit: boolean;
    confirm: (target: ConfirmTarget) => void;
    start: () => StartOf;
    beforeEdit: () => Promise<unknown>;
    afterEdit: () => void;
    offerBranch: (replay: () => Promise<ApiResult<unknown>>) => void;
};

type Saved = { ok: true } | { ok: false; error: { message: string; fields?: Record<string, string> } };

function useFlowTriggers(flowId: string) {
    const [triggers, setTriggers] = useState<{ flowId: string; value: FlowTriggers } | null>(null);
    const load = async () => {
        const result = await getFlowTriggers(flowId);
        if (result.ok) {
            setTriggers({ flowId, value: result.value });
        }
    };
    useEffect(() => {
        let gone = false;
        void getFlowTriggers(flowId).then(result => !gone && result.ok && setTriggers({ flowId, value: result.value }));
        return () => {
            gone = true;
        };
    }, [flowId]);
    useTriggersChanged(load);
    return { triggers: triggers?.flowId === flowId ? triggers.value : null, load };
}

function useFileEdit(props: TriggerWindowProps, triggers: FlowTriggers | null) {
    const changes = Boolean(props.canEdit && triggers && (triggers.file.editable || triggers.file.offersBranch));
    const edit = async (run: () => Promise<ApiResult<unknown>>): Promise<Saved> => {
        if (triggers?.file.offersBranch) {
            props.offerBranch(run);
            return { ok: true };
        }
        await props.beforeEdit();
        const result = await run();
        props.afterEdit();
        window.dispatchEvent(new Event(CHANGES_CHANGED));
        return result;
    };
    return { changes, edit };
}

const switched = () => window.dispatchEvent(new Event(TRIGGERS_SWITCHED));

const fileNotice = (triggers: FlowTriggers, kind: 'schedule' | 'webhook') =>
    triggers.file.readOnly
        ? triggers.file.readOnly
        : triggers.file.offersBranch
          ? `This environment only takes pull requests: changing a ${kind} creates a branch of your own, and the change goes there. Turning it on and its values here stay editable.`
          : triggers.environment === null
            ? `A work branch: a ${kind} changed here goes in the flow's file and is committed to this branch. Whether it runs and this environment's values are set on the environment, after the ${kind} reaches it.`
            : `A ${kind} added, changed or removed goes in the flow's file and is committed with it; it arrives disabled. Turning it on and this environment's values are saved at once.`;

function EnvironmentPart({ children }: { children: ReactNode }) {
    return (
        <div className="mt-1.5 grid gap-1 rounded-md bg-muted/50 px-2 py-1.5 text-xs">
            <span className="font-medium text-muted-foreground">This environment</span>
            {children}
        </div>
    );
}

const NOT_HERE = 'Not on this environment yet: commit it, and it arrives disabled.';

function ChipCount({ total, on, tone, arrived }: { total: number; on: number | null; tone: string; arrived: number }) {
    return (
        <>
            {total > 0 && (
                <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', on ? tone : 'bg-muted text-muted-foreground')}>
                    {on === null ? total : `${on}/${total}`}
                </span>
            )}
            {arrived > 0 && <span className="size-1.5 rounded-full bg-sky-500" aria-label={`${arrived} arrived disabled`} />}
        </>
    );
}

function RowActions({ show, onEdit, onDelete }: { show: boolean; onEdit: () => void; onDelete: () => void }) {
    return show ? (
        <div className="flex shrink-0 items-center">
            <Button variant="ghost" size="icon-sm" aria-label="Edit" onClick={onEdit}>
                <Pencil />
            </Button>
            <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete"
                className="text-destructive hover:text-destructive"
                onClick={onDelete}
            >
                <Trash2 />
            </Button>
        </div>
    ) : null;
}

export function GitSchedulesMenu(props: TriggerWindowProps) {
    const { flowId, disabled, canEdit, confirm, start } = props;
    const { triggers } = useFlowTriggers(flowId);
    const { changes, edit } = useFileEdit(props, triggers);
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<FileSchedule | 'new' | null>(null);
    const [overriding, setOverriding] = useState<Schedule | null>(null);
    const [error, setError] = useState('');

    const file = triggers?.schedules ?? [];
    const here = triggers?.environment?.schedules ?? null;
    const inFile = new Set(file.map(s => s.id));
    const gone = here?.filter(s => !inFile.has(s.id)) ?? [];
    const on = here ? here.filter(s => s.enabled).length : null;
    const arrived = here?.filter(s => s.arrivedDisabled).length ?? 0;

    const toggle = async (schedule: Schedule) => {
        setError('');
        const result = await switchSchedule(schedule.id, !schedule.enabled);
        if (!result.ok) {
            setError(result.error.message);
        }
        switched();
    };
    const remove = (schedule: FileSchedule) =>
        confirm({
            title: 'Remove this schedule from the file?',
            description: `${describeCron(schedule.cron) ?? schedule.cron}. It keeps running where it is on until the change is committed.`,
            confirmLabel: 'Remove',
            busyLabel: 'Removing…',
            destructive: true,
            onConfirm: () => edit(() => removeFileSchedule(flowId, schedule.id)) as Promise<ApiResult<unknown>>,
        });

    const environmentOf = (schedule: Schedule | undefined) =>
        here === null ? null : (
            <EnvironmentPart>
                {schedule ? (
                    <ScheduleHere
                        schedule={schedule}
                        canEdit={canEdit}
                        onToggle={() => void toggle(schedule)}
                        onOverride={() => setOverriding(schedule)}
                    />
                ) : (
                    <span className="text-muted-foreground">{NOT_HERE}</span>
                )}
            </EnvironmentPart>
        );

    return (
        <>
            <Button
                variant="outline"
                size="sm"
                className="bg-card shadow-md"
                disabled={disabled || !triggers}
                title={
                    arrived > 0
                        ? `When the flow runs by itself. ${arrived} arrived disabled: off until turned on here.`
                        : 'When the flow runs by itself'
                }
                onClick={() => setOpen(true)}
            >
                <CalendarClock /> Schedules
                <ChipCount total={file.length} on={on} arrived={arrived} tone="bg-sky-500/15 text-sky-700 dark:text-sky-300" />
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Schedules</DialogTitle>
                        {triggers && <DialogDescription>{fileNotice(triggers, 'schedule')}</DialogDescription>}
                    </DialogHeader>
                    {file.length === 0 && gone.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No schedules.</p>
                    ) : (
                        <ul className="max-h-[28rem] divide-y overflow-y-auto rounded-md border">
                            {file.map(schedule => (
                                <li key={schedule.id} className="px-3 py-2 text-sm">
                                    <div className="flex items-center gap-3">
                                        <div className="grid min-w-0 flex-1 gap-0.5">
                                            <span className="truncate font-medium">{describeCron(schedule.cron) ?? schedule.cron}</span>
                                            <span className="truncate text-xs text-muted-foreground">
                                                <span className="font-mono">{schedule.cron}</span> · {schedule.timezone} ·{' '}
                                                {MISFIRE_OPTIONS.find(m => m.mode === schedule.misfire)?.label.toLowerCase()}
                                            </span>
                                        </div>
                                        <RowActions show={changes} onEdit={() => setEditing(schedule)} onDelete={() => remove(schedule)} />
                                    </div>
                                    {environmentOf(here?.find(s => s.id === schedule.id))}
                                </li>
                            ))}
                            {gone.map(schedule => (
                                <li key={schedule.id} className="px-3 py-2 text-sm">
                                    <span className="truncate font-medium text-muted-foreground line-through">
                                        {describeCron(schedule.cron) ?? schedule.cron}
                                    </span>
                                    <EnvironmentPart>
                                        <span className="text-muted-foreground">
                                            Removed in the file: as it is here until the change is committed.
                                        </span>
                                        <ScheduleHere schedule={schedule} canEdit={canEdit} onToggle={() => void toggle(schedule)} />
                                    </EnvironmentPart>
                                </li>
                            ))}
                        </ul>
                    )}
                    {error && <p className="text-sm text-destructive">{error}</p>}
                    {changes && (
                        <DialogFooter>
                            <Button size="sm" onClick={() => setEditing('new')}>
                                <Plus /> New schedule
                            </Button>
                        </DialogFooter>
                    )}
                </DialogContent>
            </Dialog>
            {editing && (
                <ScheduleForm
                    key={editing === 'new' ? 'new' : editing.id}
                    schedule={editing === 'new' ? null : editing}
                    start={start()}
                    switchable={false}
                    onClose={() => setEditing(null)}
                    onSave={async ({ enabled: _enabled, ...fields }) => {
                        const result = await edit(() => saveFileSchedule(flowId, editing === 'new' ? null : editing.id, fields));
                        if (result.ok) {
                            setEditing(null);
                        }
                        return result;
                    }}
                />
            )}
            {overriding && (
                <OverridesForm
                    schedule={overriding}
                    start={start()}
                    onClose={() => setOverriding(null)}
                    onSaved={() => {
                        setOverriding(null);
                        switched();
                    }}
                />
            )}
        </>
    );
}

function ScheduleHere({
    schedule,
    canEdit,
    onToggle,
    onOverride,
}: {
    schedule: Schedule;
    canEdit: boolean;
    onToggle: () => void;
    onOverride?: () => void;
}) {
    const overrides = schedule.overrides;
    const overridden = Boolean(
        overrides &&
        (overrides.cron || overrides.timezone || overrides.input !== undefined || Object.keys(overrides.parameters).length > 0),
    );
    const effective = schedule.effective ?? schedule;
    return (
        <div className="flex items-start gap-3">
            <Switch
                checked={schedule.enabled}
                disabled={!canEdit}
                onCheckedChange={onToggle}
                aria-label={schedule.enabled ? 'Turn off here' : 'Turn on here'}
                title={canEdit ? undefined : 'Only an editor turns a schedule on'}
            />
            <div className="grid min-w-0 flex-1 gap-0.5 text-muted-foreground">
                <span className="flex flex-wrap items-center gap-2">
                    <span className={schedule.enabled ? 'text-emerald-700 dark:text-emerald-400' : undefined}>
                        {schedule.enabled ? 'On' : 'Off'}
                    </span>
                    {schedule.arrivedDisabled && <ArrivedBadge />}
                    <span title={schedule.nextFireAt ? formatDateTime(schedule.nextFireAt) : undefined}>
                        {schedule.nextFireAt && `Next ${relativeTime(schedule.nextFireAt)}`}
                    </span>
                    {schedule.last && (
                        <span className={LAST_TONE[schedule.last.status]} title={formatDateTime(schedule.last.at)}>
                            Last {schedule.last.status} · {relativeTime(schedule.last.at)}
                        </span>
                    )}
                </span>
                {overridden && (
                    <span className="truncate">
                        Runs here with overrides: <span className="font-mono">{effective.cron}</span> · {effective.timezone}
                        {overrides && Object.keys(overrides.parameters).length > 0 && ` · ${Object.keys(overrides.parameters).join(', ')}`}
                        {overrides?.input !== undefined && ' · input'}
                    </span>
                )}
                {schedule.lastError && (
                    <span className="truncate text-destructive" title={schedule.lastError}>
                        {schedule.lastError}
                    </span>
                )}
            </div>
            {onOverride && canEdit && (
                <Button variant="ghost" size="xs" onClick={onOverride}>
                    <SlidersHorizontal /> Overrides
                </Button>
            )}
        </div>
    );
}

const GIT_VALUE = '';

function OverridesForm({
    schedule,
    start,
    onClose,
    onSaved,
}: {
    schedule: Schedule;
    start: StartOf;
    onClose: () => void;
    onSaved: () => void;
}) {
    const overrides = schedule.overrides ?? { parameters: {} };
    const [cron, setCron] = useState(overrides.cron ?? '');
    const [timezone, setTimezone] = useState(overrides.timezone ?? GIT_VALUE);
    const [parameters, setParameters] = useState<Record<string, string>>(overrides.parameters);
    const [input, setInput] = useState(overrides.input === undefined ? '' : JSON.stringify(overrides.input, null, 2));
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    const effectiveCron = cron.trim() || schedule.cron;
    const effectiveZone = timezone || schedule.timezone;
    const problem = cronError(effectiveCron, effectiveZone);
    const names = [...new Set([...start.parameters.map(p => p.name), ...Object.keys(overrides.parameters)])];

    const save = async () => {
        let parsedInput: unknown = null;
        if (input.trim()) {
            try {
                parsedInput = JSON.parse(input);
            } catch {
                setError('The input is not valid JSON.');
                return;
            }
        }
        setSaving(true);
        const result = await overrideSchedule(schedule.id, {
            cron: cron.trim() || null,
            timezone: timezone || null,
            input: parsedInput,
            parameters: Object.fromEntries(names.map(name => [name, parameters[name]?.trim() ? parameters[name]! : null])),
        });
        setSaving(false);
        if (result.ok) {
            onSaved();
        } else {
            setError(result.error.fields?.cron ?? result.error.fields?.timezone ?? result.error.message);
        }
    };

    const gitValue = (value: ReactNode) => <span className="text-xs text-muted-foreground">Git: {value}</span>;
    return (
        <Dialog open onOpenChange={isOpen => !isOpen && onClose()}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>Overrides in this environment</DialogTitle>
                    <DialogDescription>
                        Values that run here over git&apos;s, saved at once and never written to git. Empty: git&apos;s value.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid max-h-[70vh] gap-4 overflow-y-auto pr-1">
                    <div className="grid gap-1.5">
                        <Label htmlFor="override-cron">Cron</Label>
                        <Input
                            id="override-cron"
                            className="font-mono"
                            value={cron}
                            placeholder={schedule.cron}
                            onChange={e => setCron(e.target.value)}
                        />
                        {gitValue(<span className="font-mono">{schedule.cron}</span>)}
                        <span className={cn('text-xs', problem ? 'text-destructive' : 'text-muted-foreground')}>
                            {problem ?? describeCron(effectiveCron)}
                        </span>
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="override-timezone">Time zone</Label>
                        <select id="override-timezone" className={SELECT} value={timezone} onChange={e => setTimezone(e.target.value)}>
                            <option value={GIT_VALUE}>Git&apos;s ({schedule.timezone})</option>
                            {timeZones().map(zone => (
                                <option key={zone} value={zone}>
                                    {zone}
                                </option>
                            ))}
                        </select>
                    </div>
                    {names.length > 0 && (
                        <div className="grid gap-2">
                            <Label>Parameters</Label>
                            {names.map(name => (
                                <div key={name} className="grid grid-cols-[10rem_1fr] items-center gap-2">
                                    <span className="truncate font-mono text-xs">{name}</span>
                                    <Input
                                        className="h-8"
                                        placeholder={
                                            schedule.parameters[name] ?? start.parameters.find(p => p.name === name)?.default ?? ''
                                        }
                                        value={parameters[name] ?? ''}
                                        onChange={e => setParameters(previous => ({ ...previous, [name]: e.target.value }))}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                    {(start.acceptsInput || overrides.input !== undefined) && (
                        <div className="grid gap-1.5">
                            <Label htmlFor="override-input">Input</Label>
                            <Textarea
                                id="override-input"
                                className="min-h-24 font-mono text-xs"
                                placeholder={schedule.input === undefined ? '' : JSON.stringify(schedule.input)}
                                value={input}
                                onChange={e => setInput(e.target.value)}
                            />
                            {schedule.input !== undefined && gitValue(<span className="font-mono">{JSON.stringify(schedule.input)}</span>)}
                        </div>
                    )}
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button disabled={saving || Boolean(problem)} onClick={() => void save()}>
                        {saving && <LoaderCircle className="animate-spin" />} Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function GitWebhooksMenu(props: TriggerWindowProps) {
    const { flowId, disabled, canEdit, confirm, start } = props;
    const { triggers } = useFlowTriggers(flowId);
    const { changes, edit } = useFileEdit(props, triggers);
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<FileWebhook | 'new' | null>(null);
    const [shown, setShown] = useState<{ webhook: Webhook; token: string } | null>(null);
    const [error, setError] = useState('');

    const file = triggers?.webhooks ?? [];
    const here = triggers?.environment?.webhooks ?? null;
    const inFile = new Set(file.map(w => w.id));
    const gone = here?.filter(w => !inFile.has(w.id)) ?? [];
    const on = here ? here.filter(w => w.enabled).length : null;
    const arrived = here?.filter(w => w.arrivedDisabled).length ?? 0;
    const acceptsInput = open ? start().acceptsInput : true;
    const methods = webhookMethods(acceptsInput);

    const toggle = async (webhook: Webhook) => {
        setError('');
        const result = await switchWebhook(webhook.id, !webhook.enabled);
        if (!result.ok) {
            setError(result.error.message);
        } else if (result.value.token) {
            setShown({ webhook: result.value.webhook, token: result.value.token });
        }
        switched();
    };
    const newToken = (webhook: Webhook) =>
        confirm({
            title: `New token for ${webhook.name}?`,
            description: `The token ${webhook.tokenHint}… stops working at once.`,
            confirmLabel: 'New token',
            busyLabel: 'Making…',
            destructive: true,
            onConfirm: async () => {
                const result = await regenerateToken(webhook.id);
                if (result.ok) {
                    setShown(result.value);
                    switched();
                }
                return result;
            },
        });
    const remove = (webhook: FileWebhook) =>
        confirm({
            title: `Remove ${webhook.name} from the file?`,
            description: 'Its address keeps answering where it is on until the change is committed.',
            confirmLabel: 'Remove',
            busyLabel: 'Removing…',
            destructive: true,
            onConfirm: () => edit(() => removeFileWebhook(flowId, webhook.id)) as Promise<ApiResult<unknown>>,
        });

    const hereOf = (webhook: Webhook) => (
        <div className="flex items-center gap-3">
            <Switch
                checked={webhook.enabled}
                disabled={!canEdit}
                onCheckedChange={() => void toggle(webhook)}
                aria-label={webhook.enabled ? 'Turn off here' : 'Turn on here'}
                title={canEdit ? undefined : 'Only an editor turns a webhook on'}
            />
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-muted-foreground">
                <span className={webhook.enabled ? 'text-emerald-700 dark:text-emerald-400' : undefined}>
                    {webhook.enabled ? 'On' : 'Off'}
                </span>
                {webhook.arrivedDisabled && <ArrivedBadge />}
                <TokenHint hint={webhook.tokenHint} />
                {webhook.last && (
                    <span className={callTone(webhook.last.status)} title={formatDateTime(webhook.last.at)}>
                        last call {webhook.last.status} {relativeTime(webhook.last.at)}
                    </span>
                )}
            </span>
            {canEdit && webhook.tokenHint && (
                <Button variant="ghost" size="xs" onClick={() => newToken(webhook)}>
                    <KeyRound /> New token
                </Button>
            )}
        </div>
    );

    return (
        <>
            <Button
                variant="outline"
                size="sm"
                className="bg-card shadow-md"
                disabled={disabled || !triggers}
                title={
                    arrived > 0
                        ? `Addresses other systems call to run the flow. ${arrived} arrived disabled: off until turned on here.`
                        : 'Addresses other systems call to run the flow'
                }
                onClick={() => setOpen(true)}
            >
                <WebhookIcon /> Webhooks
                <ChipCount total={file.length} on={on} arrived={arrived} tone="bg-violet-500/15 text-violet-700 dark:text-violet-300" />
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Webhooks</DialogTitle>
                        {triggers && <DialogDescription>{fileNotice(triggers, 'webhook')}</DialogDescription>}
                    </DialogHeader>
                    {file.length === 0 && gone.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No webhooks.</p>
                    ) : (
                        <ul className="max-h-[28rem] divide-y overflow-y-auto rounded-md border">
                            {file.map(webhook => {
                                const url = webhookUrl(serverOrigin(), `wh/${webhook.id}`);
                                const live = here?.find(w => w.id === webhook.id);
                                return (
                                    <li key={webhook.id} className="px-3 py-2 text-sm">
                                        <div className="flex items-center gap-3">
                                            <div className="grid min-w-0 flex-1 gap-0.5">
                                                <span className="truncate font-medium">{webhook.name}</span>
                                                <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                                                    {methods.map(m => (
                                                        <span key={m} className="shrink-0 rounded bg-muted px-1 font-mono text-[10px]">
                                                            {m}
                                                        </span>
                                                    ))}
                                                    <span className="truncate font-mono" title={url}>
                                                        {url}
                                                    </span>
                                                    <span className="shrink-0">
                                                        · {WEBHOOK_RESPONSE_OPTIONS.find(r => r.value === webhook.response)?.label}
                                                    </span>
                                                </span>
                                            </div>
                                            <CopyButton text={url} label="Copy the address" />
                                            <RowActions
                                                show={changes}
                                                onEdit={() => setEditing(webhook)}
                                                onDelete={() => remove(webhook)}
                                            />
                                        </div>
                                        {here !== null && (
                                            <EnvironmentPart>
                                                {live ? hereOf(live) : <span className="text-muted-foreground">{NOT_HERE}</span>}
                                            </EnvironmentPart>
                                        )}
                                    </li>
                                );
                            })}
                            {gone.map(webhook => (
                                <li key={webhook.id} className="px-3 py-2 text-sm">
                                    <span className="truncate font-medium text-muted-foreground line-through">{webhook.name}</span>
                                    <EnvironmentPart>
                                        <span className="text-muted-foreground">
                                            Removed in the file: as it is here until the change is committed.
                                        </span>
                                        {hereOf(webhook)}
                                    </EnvironmentPart>
                                </li>
                            ))}
                        </ul>
                    )}
                    {error && <p className="text-sm text-destructive">{error}</p>}
                    {changes && (
                        <DialogFooter>
                            <Button size="sm" onClick={() => setEditing('new')}>
                                <Plus /> New webhook
                            </Button>
                        </DialogFooter>
                    )}
                </DialogContent>
            </Dialog>
            {editing && (
                <WebhookForm
                    key={editing === 'new' ? 'new' : editing.id}
                    webhook={editing === 'new' ? null : editing}
                    switchable={false}
                    onClose={() => setEditing(null)}
                    onSave={async ({ name, response }) => {
                        const result = await edit(() => saveFileWebhook(flowId, editing === 'new' ? null : editing.id, { name, response }));
                        if (result.ok) {
                            setEditing(null);
                        }
                        return result;
                    }}
                />
            )}
            {shown && (
                <TokenDialog webhook={shown.webhook} token={shown.token} acceptsInput={acceptsInput} onClose={() => setShown(null)} />
            )}
        </>
    );
}
