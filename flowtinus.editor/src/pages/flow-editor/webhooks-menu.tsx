import { useEffect, useState } from 'react';
import { KeyRound, LoaderCircle, Pencil, Plus, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { START, startConfig, type WebhookResponse } from '@flowtinus/core';
import type { ConfirmTarget } from '@/components/confirm-dialog';
import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { FlowVersion } from '@/data/deployments/deployment';
import { WEBHOOK_RESPONSE_OPTIONS, webhookCurl, webhookMethods, webhookUrl, type Webhook, type WebhookFields } from '@/data/webhooks/webhook';
import { createWebhook, deleteWebhook, listWebhooks, regenerateToken, switchWebhook, updateWebhook } from '@/data/webhooks/webhooks-api';
import { TRIGGERS_SWITCHED } from '@/data/git/git-api';
import { ArrivedBadge, useTriggersChanged } from './use-triggers-changed';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

const SELECT = 'h-8 w-full rounded-md border bg-transparent px-2 text-sm';

/** where the server answers (in development the editor's /api, which Vite sends to it) */
const serverOrigin = () => `${window.location.origin}/api`;

type Props = {
    flowId: string;
    /** the deployed version (what its webhooks run); null: not deployed, no webhook can be made */
    deployed: FlowVersion | null;
    disabled: boolean;
    confirm: (target: ConfirmTarget) => void;
};

/**
 * Webhooks in the canvas' tools (after Schedules): how many the flow has, and a window with them (each one's address,
 * how it answers, its token's first characters, its last call) where they are added, changed, turned off, given a new
 * token and removed. A token is shown once, when it is made. Only a deployed flow can have one; POST always, GET too when
 * its Start takes no input.
 */
export function WebhooksMenu({ flowId, deployed, disabled, confirm }: Props) {
    const [open, setOpen] = useState(false);
    const [webhooks, setWebhooks] = useState<{ flowId: string; items: Webhook[] } | null>(null);
    const items = webhooks?.flowId === flowId ? webhooks.items : [];
    const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
    const [shown, setShown] = useState<{ webhook: Webhook; token: string } | null>(null);

    const load = async () => {
        const result = await listWebhooks(flowId);
        if (result.ok) {
            setWebhooks({ flowId, items: result.value });
        }
    };

    useEffect(() => {
        let gone = false;
        void listWebhooks(flowId).then(result => !gone && result.ok && setWebhooks({ flowId, items: result.value }));
        return () => {
            gone = true;
        };
    }, [flowId]);
    useTriggersChanged(load);

    const active = items.filter(w => w.enabled).length;
    const arrived = items.filter(w => w.arrivedDisabled).length;
    // a flow whose Start takes no input may be called with GET too
    const acceptsInput = deployed ? startConfig(deployed.definition.nodes.find(n => n.type === START)?.config ?? {}).acceptsInput : true;
    const methods = webhookMethods(acceptsInput);
    const toggle = async (webhook: Webhook) => {
        const result = await switchWebhook(webhook.id, !webhook.enabled);
        if (result.ok && result.value.token) {
            setShown({ webhook: result.value.webhook, token: result.value.token });
        }
        window.dispatchEvent(new Event(TRIGGERS_SWITCHED));
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
                    await load();
                }

                return result;
            },
        });
    const remove = (webhook: Webhook) =>
        confirm({
            title: `Delete ${webhook.name}?`,
            description: 'Calls to its address stop working.',
            confirmLabel: 'Delete',
            busyLabel: 'Deleting…',
            destructive: true,
            onConfirm: async () => {
                const result = await deleteWebhook(webhook.id);
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
                title={
                    !deployed
                        ? 'Deploy the flow first'
                        : arrived > 0
                          ? `Addresses other systems call to run the deployed version. ${arrived} arrived disabled: off until turned on here.`
                          : 'Addresses other systems call to run the deployed version'
                }
                onClick={() => setOpen(true)}
            >
                <WebhookIcon /> Webhooks
                {items.length > 0 && (
                    <span
                        className={cn(
                            'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                            active ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : 'bg-muted text-muted-foreground',
                        )}
                    >
                        {active}/{items.length}
                    </span>
                )}
                {arrived > 0 && <span className="size-1.5 rounded-full bg-sky-500" aria-label={`${arrived} arrived disabled`} />}
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Webhooks{deployed ? ` · v${deployed.number}` : ''}</DialogTitle>
                    </DialogHeader>
                    {items.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No webhooks.</p>
                    ) : (
                        <ul className="max-h-96 divide-y overflow-y-auto rounded-md border">
                            {items.map(webhook => (
                                <WebhookRow
                                    key={webhook.id}
                                    webhook={webhook}
                                    methods={methods}
                                    onToggle={() => void toggle(webhook)}
                                    onEdit={() => setEditing(webhook)}
                                    onNewToken={() => newToken(webhook)}
                                    onDelete={() => remove(webhook)}
                                />
                            ))}
                        </ul>
                    )}
                    <DialogFooter>
                        <Button size="sm" disabled={!deployed} onClick={() => setEditing('new')}>
                            <Plus /> New webhook
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {editing && (
                <WebhookForm
                    key={editing === 'new' ? 'new' : editing.id}
                    webhook={editing === 'new' ? null : editing}
                    onClose={() => setEditing(null)}
                    onSave={async fields => {
                        if (editing === 'new') {
                            const result = await createWebhook(flowId, fields);
                            if (result.ok) {
                                setEditing(null);
                                setShown(result.value);
                                await load();
                            }

                            return result;
                        }

                        const result = await updateWebhook(editing.id, fields);
                        if (result.ok) {
                            setEditing(null);
                            await load();
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

const callTone = (status: number) => (status < 300 ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive');

function WebhookRow(props: {
    webhook: Webhook;
    methods: string[];
    onToggle: () => void;
    onEdit: () => void;
    onNewToken: () => void;
    onDelete: () => void;
}) {
    const { webhook, methods, onToggle, onEdit, onNewToken, onDelete } = props;
    const url = webhookUrl(serverOrigin(), webhook.path);
    return (
        <li className="flex items-center gap-3 px-3 py-2 text-sm">
            <Switch checked={webhook.enabled} onCheckedChange={onToggle} aria-label={webhook.enabled ? 'Turn off' : 'Turn on'} />
            <div className={cn('grid min-w-0 flex-1 gap-0.5', !webhook.enabled && 'opacity-60')}>
                <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{webhook.name}</span>
                    {webhook.arrivedDisabled && <ArrivedBadge />}
                </span>
                <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    {methods.map(m => (
                        <span key={m} className="shrink-0 rounded bg-muted px-1 font-mono text-[10px]">
                            {m}
                        </span>
                    ))}
                    <span className="truncate font-mono" title={url}>
                        {url}
                    </span>
                </span>
                <span className="truncate text-xs text-muted-foreground">
                    {WEBHOOK_RESPONSE_OPTIONS.find(r => r.value === webhook.response)?.label} · token{' '}
                    <span className="font-mono">{webhook.tokenHint}…</span>
                    {webhook.last && (
                        <>
                            {' · '}
                            <span className={callTone(webhook.last.status)} title={formatDateTime(webhook.last.at)}>
                                last call {webhook.last.status} {relativeTime(webhook.last.at)}
                            </span>
                        </>
                    )}
                </span>
            </div>
            <CopyButton text={url} label="Copy the address" />
            <Button variant="ghost" size="icon-sm" aria-label="New token" title="New token" onClick={onNewToken}>
                <KeyRound />
            </Button>
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

/** the name, how it answers, on or off */
function WebhookForm(props: {
    webhook: Webhook | null;
    onClose: () => void;
    onSave: (fields: WebhookFields) => Promise<{ ok: true } | { ok: false; error: { message: string; fields?: Record<string, string> } }>;
}) {
    const { webhook, onClose, onSave } = props;
    const [name, setName] = useState(webhook?.name ?? '');
    const [response, setResponse] = useState<WebhookResponse>(webhook?.response ?? 'async');
    const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    const save = async () => {
        setSaving(true);
        const result = await onSave({ name, response, enabled });
        setSaving(false);
        if (!result.ok) {
            setError(result.error.fields?.name ?? result.error.message);
        }
    };

    return (
        <Dialog open onOpenChange={isOpen => !isOpen && onClose()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader className="flex-row items-center gap-3 pr-8">
                    <DialogTitle className="flex-1">{webhook ? 'Edit webhook' : 'New webhook'}</DialogTitle>
                    <label className="flex items-center gap-2 text-sm font-normal">
                        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="On" />
                        {enabled ? 'On' : 'Off'}
                    </label>
                </DialogHeader>
                <div className="grid gap-4">
                    <div className="grid gap-1.5">
                        <Label htmlFor="webhook-name">Name</Label>
                        <Input id="webhook-name" value={name} placeholder="Orders from the shop" onChange={e => setName(e.target.value)} />
                    </div>
                    <div className="grid gap-1.5">
                        <Label htmlFor="webhook-response">Answers</Label>
                        <select
                            id="webhook-response"
                            className={SELECT}
                            value={response}
                            onChange={e => setResponse(e.target.value as WebhookResponse)}
                        >
                            {WEBHOOK_RESPONSE_OPTIONS.map(r => (
                                <option key={r.value} value={r.value}>
                                    {r.label}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button disabled={saving || !name.trim()} onClick={() => void save()}>
                        {saving && <LoaderCircle className="animate-spin" />} Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** the token, shown this once, its address and a call to try it */
export function TokenDialog({
    webhook,
    token,
    acceptsInput,
    onClose,
}: {
    webhook: Webhook;
    token: string;
    acceptsInput: boolean;
    onClose: () => void;
}) {
    const url = webhookUrl(serverOrigin(), webhook.path);
    const curl = webhookCurl(url, token, acceptsInput);
    return (
        <Dialog open onOpenChange={isOpen => !isOpen && onClose()}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{webhook.name}</DialogTitle>
                </DialogHeader>
                {/* columns of flex, not grid: a grid grows to the curl's long line and the copy buttons went out of the dialog */}
                <div className="flex min-w-0 flex-col gap-3">
                    <div className="flex flex-col gap-1">
                        <Label>Address</Label>
                        <div className="flex items-center gap-1 rounded-md border px-2 py-1">
                            <span className="min-w-0 flex-1 truncate font-mono text-xs">{url}</span>
                            <CopyButton text={url} label="Copy the address" />
                        </div>
                    </div>
                    <div className="flex flex-col gap-1">
                        <Label>Token (shown once)</Label>
                        <div className="flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/5 px-2 py-1">
                            <span className="min-w-0 flex-1 truncate font-mono text-xs">{token}</span>
                            <CopyButton text={token} label="Copy the token" />
                        </div>
                    </div>
                    <div className="flex flex-col gap-1">
                        <Label>Example</Label>
                        <div className="flex items-start gap-1 rounded-md border bg-muted/40 px-2 py-1">
                            <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre">{curl}</pre>
                            <CopyButton text={curl} label="Copy the example" />
                        </div>
                    </div>
                </div>
                <DialogFooter>
                    <Button onClick={onClose}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
