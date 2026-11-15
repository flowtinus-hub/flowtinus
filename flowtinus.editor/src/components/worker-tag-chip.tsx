import { Tag } from 'lucide-react';
import { cn } from '@/lib/utils';

/** a flow's worker tag (which supervisors run it), small, in its supervisors' color (WORKER_COLOR) when they have one */
export function WorkerTagChip({ tag, color, className }: { tag: string; color?: string | null; className?: string }) {
    return (
        <span
            className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-md border bg-muted/50 px-1.5 py-0.5 font-mono text-xs text-muted-foreground',
                className,
            )}
            style={
                color
                    ? {
                          borderColor: `color-mix(in oklch, ${color} 55%, transparent)`,
                          backgroundColor: `color-mix(in oklch, ${color} 12%, transparent)`,
                      }
                    : undefined
            }
            title={`Run by the workers of the tag "${tag}"`}
        >
            <Tag className="size-3" style={color ? { color } : undefined} />
            {tag}
        </span>
    );
}
