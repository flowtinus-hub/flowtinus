import { cn } from '@/lib/utils';

/** the deployed version a run ran ("v3"); nothing for a run of the draft */
export function VersionChip({ version, className }: { version: number | undefined; className?: string }) {
    if (version === undefined) {
        return null;
    }

    return (
        <span
            className={cn('shrink-0 rounded-md bg-muted px-1 py-px font-mono text-[11px] font-normal text-muted-foreground', className)}
            title={`Deployed version ${version}`}
        >
            v{version}
        </span>
    );
}
