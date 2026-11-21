import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { CalendarClock, Webhook as WebhookIcon, Workflow } from 'lucide-react';
import { flowPath } from '@/app/paths';
import { Switch } from '@/components/ui/switch';
import { TRIGGERS_SWITCHED, type ArrivedDisabled } from '@/data/git/git-api';
import { describeCron } from '@/data/schedules/schedule';
import { switchSchedule } from '@/data/schedules/schedules-api';
import type { Webhook } from '@/data/webhooks/webhook';
import { switchWebhook } from '@/data/webhooks/webhooks-api';
import { useWorkspace } from '@/data/workspaces/use-workspace';
import { TokenDialog } from '@/pages/flow-editor/webhooks-menu';
import { cn } from '@/lib/utils';

export function ArrivedDisabledList({ handle, items, className }: { handle: string; items: ArrivedDisabled[]; className?: string }) {
    const { canEdit } = useWorkspace();
    const [enabled, setEnabled] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [shown, setShown] = useState<{ webhook: Webhook; token: string } | null>(null);

    const turn = async (id: string, on: boolean, switching: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>) => {
        setBusy(id);
        setError(null);
        const result = await switching();
        setBusy(null);
        if (result.ok) {
            setEnabled(current => ({ ...current, [id]: on }));
            window.dispatchEvent(new Event(TRIGGERS_SWITCHED));
        } else {
            setError(result.error.message);
        }
    };
    const turnSchedule = (id: string, on: boolean) => turn(id, on, () => switchSchedule(id, on));
    const turnWebhook = (id: string, on: boolean) =>
        turn(id, on, async () => {
            const result = await switchWebhook(id, on);
            if (result.ok && result.value.token) {
                setShown({ webhook: result.value.webhook, token: result.value.token });
            }
            return result;
        });

    const row = (id: string, on: boolean, toggle: (on: boolean) => void, icon: ReactNode, label: ReactNode, detail: string) => (
        <li key={id} className="flex items-center gap-3 px-3 py-1.5">
            <Switch
                checked={on}
                disabled={!canEdit || busy === id}
                onCheckedChange={toggle}
                aria-label={on ? 'Turn off' : 'Turn on'}
                title={canEdit ? undefined : 'Only an editor turns a trigger on'}
            />
            {icon}
            <span className={cn('grid min-w-0 flex-1', !on && 'opacity-70')}>
                <span className="truncate">{label}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{detail}</span>
            </span>
            <span className={cn('shrink-0 text-xs', on ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}>
                {on ? 'On' : 'Off'}
            </span>
        </li>
    );

    return (
        <div className={cn('grid gap-2 text-sm', className)}>
            {items.map(item => (
                <div key={item.flowId} className="grid rounded-md border">
                    <Link
                        to={flowPath(handle, item.projectId, item.flowId)}
                        className="flex items-center gap-2 border-b px-3 py-1.5 font-medium hover:underline"
                    >
                        <Workflow className="size-4 text-muted-foreground" /> {item.flowName}
                    </Link>
                    <ul className="divide-y">
                        {item.schedules.map(s =>
                            row(
                                s.id,
                                enabled[s.id] ?? s.enabled,
                                on => void turnSchedule(s.id, on),
                                <CalendarClock className="size-4 shrink-0 text-muted-foreground" />,
                                describeCron(s.cron) ?? s.cron,
                                `${s.cron} · ${s.timezone}`,
                            ),
                        )}
                        {item.webhooks.map(w =>
                            row(
                                w.id,
                                enabled[w.id] ?? w.enabled,
                                on => void turnWebhook(w.id, on),
                                <WebhookIcon className="size-4 shrink-0 text-muted-foreground" />,
                                w.name,
                                w.path,
                            ),
                        )}
                    </ul>
                </div>
            ))}
            {error && <p className="text-xs text-destructive">{error}</p>}
            {shown && <TokenDialog webhook={shown.webhook} token={shown.token} acceptsInput onClose={() => setShown(null)} />}
        </div>
    );
}
