import { Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function EmergencyRollbackBadge({
    number,
    gitNumber,
    byName,
    small = false,
}: {
    number: number;
    gitNumber: number;
    byName?: string;
    small?: boolean;
}) {
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center gap-1 bg-red-500/15 px-1.5 py-0.5 font-mono font-medium text-red-700 dark:text-red-400',
                small ? 'rounded-full text-[10px]' : 'rounded-md text-xs',
            )}
            title={`v${number} runs here instead of git's v${gitNumber}: an emergency rollback${byName ? ` by ${byName}` : ''}`}
        >
            {!small && <Undo2 className="size-3" />}v{number} · emergency rollback
        </span>
    );
}
