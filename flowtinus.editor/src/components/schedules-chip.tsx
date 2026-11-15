import { CalendarClock } from 'lucide-react';
import { cn } from '@/lib/utils';

/** a flow's schedules in the lists (a clock with how many are on); nothing when it has none */
export function SchedulesChip({
    schedules,
    className,
}: {
    schedules: { total: number; on: number } | null | undefined;
    className?: string;
}) {
    if (!schedules || schedules.total === 0) {
        return null;
    }

    const { total, on } = schedules;
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs',
                on > 0 ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'bg-muted/50 text-muted-foreground',
                className,
            )}
            title={`${on} of ${total} schedule(s) on`}
        >
            <CalendarClock className="size-3" />
            {on}/{total}
        </span>
    );
}
