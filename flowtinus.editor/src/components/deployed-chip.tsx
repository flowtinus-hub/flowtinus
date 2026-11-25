import { Rocket, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/** a flow's deployed version in the lists ("v3"), or that it is not deployed, or that it runs in an emergency rollback */
export function DeployedChip({
    version,
    emergencyRollback,
    className,
}: {
    version: number | null | undefined;
    emergencyRollback?: { number: number; gitNumber: number; byName?: string };
    className?: string;
}) {
    if (version === undefined) {
        return null;
    }

    if (emergencyRollback) {
        const by = emergencyRollback.byName ? ` by ${emergencyRollback.byName}` : '';
        return (
            <span
                className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-md bg-red-500/15 px-1.5 py-0.5 font-mono text-xs text-red-700 dark:text-red-400',
                    className,
                )}
                title={`v${emergencyRollback.number} runs here instead of git's v${emergencyRollback.gitNumber}: an emergency rollback${by}`}
            >
                <Undo2 className="size-3" />v{emergencyRollback.number} · emergency rollback
            </span>
        );
    }

    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs',
                version === null
                    ? 'bg-muted/50 text-muted-foreground'
                    : 'bg-emerald-500/15 font-mono text-emerald-700 dark:text-emerald-400',
                className,
            )}
            title={version === null ? 'Not deployed' : `v${version} is deployed`}
        >
            <Rocket className="size-3" />
            {version === null ? 'Not deployed' : `v${version}`}
        </span>
    );
}
