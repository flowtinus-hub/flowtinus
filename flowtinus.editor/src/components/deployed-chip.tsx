import { Rocket } from 'lucide-react';
import { cn } from '@/lib/utils';

/** a flow's deployed version in the lists ("v3"), or that it is not deployed */
export function DeployedChip({ version, className }: { version: number | null | undefined; className?: string }) {
    if (version === undefined) {
        return null;
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
