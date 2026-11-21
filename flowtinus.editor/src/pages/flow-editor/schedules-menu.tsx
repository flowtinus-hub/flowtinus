import { useEffect, useState } from 'react';
import { CalendarClock, LoaderCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { cronError, nextTimes, startConfig, START, type FlowFile, type MisfireMode } from '@flowtinus/core';
import type { ConfirmTarget } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { FlowVersion } from '@/data/deployments/deployment';
import { browserTimeZone, CRON_PRESETS, describeCron, MISFIRE_OPTIONS, timeZones, type Schedule, type ScheduleFields } from '@/data/schedules/schedule';
import { createSchedule, deleteSchedule, listSchedules, switchSchedule, updateSchedule } from '@/data/schedules/schedules-api';
import { TRIGGERS_SWITCHED } from '@/data/git/git-api';
import { useTriggersChanged } from './use-triggers-changed';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

export const SELECT = 'h-8 w-full rounded-md border bg-transparent px-2 text-sm';

export type StartOf = ReturnType<typeof startConfig>;

export const startOf = (flow: Pick<FlowFile, 'nodes'>): StartOf => startConfig(flow.nodes.find(n => n.type === START)?.config ?? {});

type Props = {
    flowId: string;
    /** the deployed version (what the schedules run); null: not deployed, nothing can be scheduled */
    deployed: FlowVersion | null;
    disabled: boolean;
    confirm: (target: ConfirmTarget) => void;
};

/**
 * Schedules in the canvas' tools (after Deploy): how many the flow has, and a window with them (each one's expression in
 * words, time zone, next time, how the last time went) where they are added, changed, turned off and removed. Only a
 * deployed flow can have one: they run its deployed version.
 */
export function SchedulesMenu({ flowId, deployed, disabled, confirm }: Props) {
    const [open, setOpen] = useState(false);
    const [schedules, setSchedules] = useState<{ flowId: string; items: Schedule[] } | null>(null);
    const items = schedules?.flowId === flowId ? schedules.items : [];
    const [editing, setEditing] = useState<Schedule | 'new' | null>(null);

    const load = async () => {
        const result = await listSchedules(flowId);
        if (result.ok) {
            setSchedules({ flowId, items: result.value });
        }
    };

    useEffect(() => {
        let gone = false;
        void listSchedules(flowId).then(result => !gone && result.ok && setSchedules({ flowId, items: result.value }));
        return () => {
            gone = true;
        };
    }, [flowId]);
    useTriggersChanged(load);

    const active = items.filter(s => s.enabled).length;
    const toggle = async (schedule: Schedule) => {
        await switchSchedule(schedule.id, !schedule.enabled);
        window.dispatchEvent(new Event(TRIGGERS_SWITCHED));
    };
    const remove = (schedule: Schedule) =>
        confirm({
            title: 'Delete this schedule?',
            description: describeCron(schedule.cron) ?? schedule.cron,
            confirmLabel: 'Delete',
            busyLabel: 'Deleting…',
            destructive: true,
            onConfirm: async () => {
                const result = await deleteSchedule(schedule.id);
                await load();
                return result;
            },
        });

    return (
        <>
            <Button
                variant="outline"
                size="sm"
                className="bg-card shadow-md"
                disabled={disabled || !deployed}
                title={deployed ? 'When the deployed version runs by itself' : 'Deploy the flow first'}
                onClick={() => setOpen(true)}
            >
                <CalendarClock /> Schedules
                {items.length > 0 && (
                    <span
                        className={cn(
                            'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                            active ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'bg-muted text-muted-foreground',
                        )}
                    >
                        {active}/{items.length}
                    </span>
                )}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Schedules{deployed ? ` · v${deployed.number}` : ''}</DialogTitle>
                    </DialogHeader>
                    {items.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No schedules.</p>
                    ) : (
                        <ul className="max-h-96 divide-y overflow-y-auto rounded-md border">
                            {items.map(schedule => (
                                <ScheduleRow
                                    key={schedule.id}
                                    schedule={schedule}
                                    onToggle={() => void toggle(schedule)}
                                    onEdit={() => setEditing(schedule)}
                                    onDelete={() => remove(schedule)}
                                />
                            ))}
                        </ul>
                    )}
                    <DialogFooter>
                        <Button size="sm" disabled={!deployed} onClick={() => setEditing('new')}>
                            <Plus /> New schedule
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {editing && deployed && (
                <ScheduleForm
                    key={editing === 'new' ? 'new' : editing.id}
                    schedule={editing === 'new' ? null : editing}
                    start={startOf(deployed.definition)}
                    onClose={() => setEditing(null)}
                    onSave={async fields => {
                        const result = editing === 'new' ? await createSchedule(flowId, fields) : await updateSchedule(editing.id, fields);
                        if (result.ok) {
                            setEditing(null);
                            await load();
                        }

                        return result;
                    }}
                />
            )}
        </>
    );
}

export const LAST_TONE: Record<string, string> = {
    failed: 'text-destructive',
    'with-errors': 'text-destructive',
    skipped: 'text-amber-700 dark:text-amber-400',
    completed: 'text-emerald-700 dark:text-emerald-400',
};

function ScheduleRow({
    schedule,
    onToggle,
    onEdit,
    onDelete,
}: {
    schedule: Schedule;
    onToggle: () => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    return (
        <li className="flex items-center gap-3 px-3 py-2 text-sm">
            <Switch checked={schedule.enabled} onCheckedChange={onToggle} aria-label={schedule.enabled ? 'Turn off' : 'Turn on'} />
            <div className={cn('grid min-w-0 flex-1 gap-0.5', !schedule.enabled && 'opacity-60')}>
                <span className="truncate font-medium">{describeCron(schedule.cron) ?? schedule.cron}</span>
                <span className="truncate text-xs text-muted-foreground">
                    <span className="font-mono">{schedule.cron}</span> · {schedule.timezone}
                </span>
            </div>
            <div className="grid shrink-0 gap-0.5 text-right text-xs text-muted-foreground">
                <span title={schedule.nextFireAt ? formatDateTime(schedule.nextFireAt) : undefined}>
                    {schedule.nextFireAt ? `Next ${relativeTime(schedule.nextFireAt)}` : 'Off'}
                </span>
                {schedule.last && (
                    <span className={LAST_TONE[schedule.last.status]} title={formatDateTime(schedule.last.at)}>
                        Last {schedule.last.status} · {relativeTime(schedule.last.at)}
                    </span>
                )}
                {schedule.lastError && (
                    <span className="text-destructive" title={schedule.lastError}>
                        {schedule.lastError}
                    </span>
                )}
            </div>
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
        </li>
    );
}

/** the cron expression, its time zone, what to do with missed times, and the Start's parameters and input */
export function ScheduleForm(props: {
    schedule: (Omit<ScheduleFields, 'enabled'> & { enabled?: boolean }) | null;
    start: StartOf;
    switchable?: boolean;
    onClose: () => void;
    onSave: (fields: ScheduleFields) => Promise<{ ok: true } | { ok: false; error: { message: string; fields?: Record<string, string> } }>;
}) {
    const { schedule, start, switchable = true, onClose, onSave } = props;
    const [preset, setPreset] = useState(schedule ? 'custom' : 'daily');
    const [amount, setAmount] = useState(15);
    const [time, setTime] = useState('09:00');
    const [custom, setCustom] = useState(schedule?.cron ?? '');
    const [timezone, setTimezone] = useState(schedule?.timezone ?? browserTimeZone());
    const [misfire, setMisfire] = useState<MisfireMode>(schedule?.misfire ?? 'relaxed');
    const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
    const [parameters, setParameters] = useState<Record<string, string>>(schedule?.parameters ?? {});
    const [input, setInput] = useState(schedule?.input === undefined ? '' : JSON.stringify(schedule.input, null, 2));
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    const chosen = CRON_PRESETS.find(p => p.id === preset)!;
    const cron = preset === 'custom' ? custom : chosen.cron(amount, time);
    const problem = cron.trim() ? cronError(cron, timezone) : 'Write a cron expression.';
    const words = problem ? undefined : describeCron(cron);
    const next = problem ? [] : nextTimes(cron, timezone, 5);

    const save = async () => {
        let parsedInput: unknown;
        if (start.acceptsInput && input.trim()) {
            try {
                parsedInput = JSON.parse(input);
            } catch {
                setError('The input is not valid JSON.');
                return;
            }
        }

        setSaving(true);
        const result = await onSave({
            cron: cron.trim(),
            timezone,
            enabled,
            misfire,
            parameters: Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== '')),
            ...(parsedInput !== undefined ? { input: parsedInput } : {}),
        });
        setSaving(false);
        if (!result.ok) {
            setError(result.error.fields?.cron ?? result.error.fields?.timezone ?? result.error.message);
        }
    };

    return (
        <Dialog open onOpenChange={isOpen => !isOpen && onClose()}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader className="flex-row items-center gap-3 pr-8">
                    <DialogTitle className="flex-1">{schedule ? 'Edit schedule' : 'New schedule'}</DialogTitle>
                    {switchable && (
                        <label className="flex items-center gap-2 text-sm font-normal">
                            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="On" />
                            {enabled ? 'On' : 'Off'}
                        </label>
                    )}
                </DialogHeader>
                <div className="grid max-h-[70vh] gap-4 overflow-y-auto pr-1">
                    <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                        <div className="grid gap-1.5">
                            <Label htmlFor="schedule-preset">Runs</Label>
                            <select id="schedule-preset" className={SELECT} value={preset} onChange={e => setPreset(e.target.value)}>
                                {CRON_PRESETS.map(p => (
                                    <option key={p.id} value={p.id}>
                                        {p.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {(chosen.value === 'seconds' || chosen.value === 'minutes') && (
                            <Input
                                type="number"
                                min={1}
                                max={59}
                                className="h-8 w-20"
                                aria-label={chosen.value}
                                value={amount}
                                onChange={e => setAmount(Math.max(1, Math.min(59, Number(e.target.value) || 1)))}
                            />
                        )}
                        {chosen.value === 'time' && (
                            <Input
                                type="time"
                                className="h-8 w-32"
                                aria-label="Time"
                                value={time}
                                onChange={e => setTime(e.target.value)}
                            />
                        )}
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="schedule-cron">Cron</Label>
                        <Input
                            id="schedule-cron"
                            className="font-mono"
                            value={cron}
                            placeholder="0 9 * * 1-5"
                            onChange={e => {
                                setPreset('custom');
                                setCustom(e.target.value);
                            }}
                        />
                        <span className={cn('text-xs', problem ? 'text-destructive' : 'text-muted-foreground')}>{problem ?? words}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-1.5">
                            <Label htmlFor="schedule-timezone">Time zone</Label>
                            <select id="schedule-timezone" className={SELECT} value={timezone} onChange={e => setTimezone(e.target.value)}>
                                {timeZones().map(zone => (
                                    <option key={zone} value={zone}>
                                        {zone}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="schedule-misfire">Missed times</Label>
                            <select
                                id="schedule-misfire"
                                className={SELECT}
                                value={misfire}
                                onChange={e => setMisfire(e.target.value as MisfireMode)}
                            >
                                {MISFIRE_OPTIONS.map(m => (
                                    <option key={m.mode} value={m.mode}>
                                        {m.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    {next.length > 0 && (
                        <div className="grid gap-1">
                            <Label>Next</Label>
                            <ul className="grid gap-0.5 font-mono text-xs text-muted-foreground">
                                {next.map(at => (
                                    <li key={at.getTime()}>{formatDateTime(at)}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {start.parameters.length > 0 && (
                        <div className="grid gap-2">
                            <Label>Parameters</Label>
                            {start.parameters.map(p => (
                                <div key={p.name} className="grid grid-cols-[10rem_1fr] items-center gap-2">
                                    <span className="truncate font-mono text-xs">
                                        {p.name}
                                        {p.required && <span className="text-destructive">*</span>}
                                    </span>
                                    <Input
                                        className="h-8"
                                        placeholder={p.default}
                                        value={parameters[p.name] ?? ''}
                                        onChange={e => setParameters(previous => ({ ...previous, [p.name]: e.target.value }))}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                    {start.acceptsInput && (
                        <div className="grid gap-1.5">
                            <Label htmlFor="schedule-input">Input</Label>
                            <Textarea
                                id="schedule-input"
                                className="min-h-24 font-mono text-xs"
                                placeholder={start.testInput || '{}'}
                                value={input}
                                onChange={e => setInput(e.target.value)}
                            />
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
