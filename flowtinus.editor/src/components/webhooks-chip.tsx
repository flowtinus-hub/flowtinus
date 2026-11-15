import { Webhook } from 'lucide-react';
import { cn } from '@/lib/utils';

/** a flow's webhooks in the lists (how many are on); nothing when it has none */
export function WebhooksChip({ webhooks, className }: { webhooks: { total: number; on: number } | null | undefined; className?: string }) {
    if (!webhooks || webhooks.total === 0) {
        return null;
    }

    const { total, on } = webhooks;
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs',
                on > 0 ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300' : 'bg-muted/50 text-muted-foreground',
                className,
            )}
            title={`${on} of ${total} webhook(s) on`}
        >
            <Webhook className="size-3" />
            {on}/{total}
        </span>
    );
}
