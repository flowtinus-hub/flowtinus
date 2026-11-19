import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { getFileDiff, type FileDiff } from '@/data/git/git-api';
import type { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

export function FileDiffView({ slug, path, className }: { slug: string; path: string; className?: string }) {
    const [diff, setDiff] = useState<FileDiff | null>(null);
    const [error, setError] = useState<ApiError | null>(null);

    useEffect(() => {
        let current = true;
        setDiff(null);
        setError(null);
        void getFileDiff(slug, path).then(result => {
            if (!current) {
                return;
            }
            if (result.ok) {
                setDiff(result.value);
            } else {
                setError(result.error);
            }
        });
        return () => {
            current = false;
        };
    }, [slug, path]);

    if (error) {
        return <p className={cn('text-xs text-destructive', className)}>{error.message}</p>;
    }
    if (!diff) {
        return <LoaderCircle className={cn('size-4 animate-spin text-muted-foreground', className)} />;
    }
    if (diff.hunks.length === 0) {
        return <p className={cn('text-xs text-muted-foreground', className)}>The text is the same: only the path changed.</p>;
    }
    return (
        <pre className={cn('max-h-72 overflow-auto rounded-md border bg-muted/30 py-1 font-mono text-xs leading-5', className)}>
            {diff.hunks.map((hunk, h) => (
                <div key={h} className="min-w-fit">
                    <div className="px-3 text-muted-foreground select-none">
                        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
                    </div>
                    {hunk.lines.map((line, i) => (
                        <div
                            key={i}
                            className={cn(
                                'flex whitespace-pre',
                                line.kind === '+' && 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
                                line.kind === '-' && 'bg-red-500/15 text-red-800 dark:text-red-300',
                            )}
                        >
                            <span className="w-10 shrink-0 pr-2 text-right text-muted-foreground select-none">{line.old ?? ''}</span>
                            <span className="w-10 shrink-0 pr-2 text-right text-muted-foreground select-none">{line.new ?? ''}</span>
                            <span className="w-4 shrink-0 select-none">{line.kind}</span>
                            <span className="pr-3">{line.text}</span>
                        </div>
                    ))}
                </div>
            ))}
        </pre>
    );
}
