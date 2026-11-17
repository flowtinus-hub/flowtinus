import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { diffLines, WS, type Change } from './model';

import { PROTOTYPE_GIT_SYNC_PATH } from './path';

export const BASE = PROTOTYPE_GIT_SYNC_PATH;
export const flowRoute = (id: string) => `${BASE}/flows/${id}`;
export const projectRoute = (project: string, tab: 'flows' | 'scripts' = 'flows') =>
    `${BASE}/projects/${encodeURIComponent(project)}?tab=${tab}`;
export const prRoute = (n: number) => `${BASE}/provider/${n}`;

export const rel = (path: string) => (path.startsWith(`${WS}/`) ? path.slice(WS.length + 1) : path);

export function NameDialog({
    open,
    title,
    description,
    label,
    initial = '',
    prefix,
    confirm,
    onClose,
    onSubmit,
    children,
}: {
    children?: ReactNode;
    open: boolean;
    title: string;
    description?: ReactNode;
    label: string;
    initial?: string;
    prefix?: string;
    confirm: string;
    onClose: () => void;
    onSubmit: (value: string) => string | null;
}) {
    const [value, setValue] = useState(initial);
    const [error, setError] = useState('');
    const [lastOpen, setLastOpen] = useState(open);
    if (open !== lastOpen) {
        setLastOpen(open);
        if (open) {
            setValue(initial);
            setError('');
        }
    }
    return (
        <Dialog open={open} onOpenChange={o => !o && onClose()}>
            <DialogContent>
                <form
                    className="grid gap-4"
                    onSubmit={e => {
                        e.preventDefault();
                        const problem = onSubmit(value);
                        if (problem) {
                            setError(problem);
                        } else {
                            onClose();
                        }
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        {description && <DialogDescription>{description}</DialogDescription>}
                    </DialogHeader>
                    {children}
                    <div className="grid gap-2">
                        <Label htmlFor="proto-name">{label}</Label>
                        <div className="flex items-center gap-1">
                            {prefix && <span className="font-mono text-sm text-muted-foreground">{prefix}</span>}
                            <Input
                                id="proto-name"
                                autoFocus
                                value={value}
                                onChange={e => setValue(e.target.value)}
                                aria-invalid={!!error}
                            />
                        </div>
                        {error && <p className="text-sm text-destructive">{error}</p>}
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit">{confirm}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function DiffView({ before, after, className }: { before: string; after: string; className?: string }) {
    const lines = diffLines(before, after);
    return (
        <pre className={cn('max-h-96 overflow-auto rounded-md border bg-muted/30 py-2 font-mono text-xs leading-5', className)}>
            {lines.map((line, i) => (
                <div
                    key={i}
                    className={cn(
                        'px-3 whitespace-pre',
                        line.kind === '+' && 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
                        line.kind === '-' && 'bg-red-500/15 text-red-800 dark:text-red-300',
                    )}
                >
                    {line.kind} {line.text}
                </div>
            ))}
        </pre>
    );
}

const STATUS: Record<Change['status'], { letter: string; className: string; label: string }> = {
    added: { letter: 'A', className: 'text-emerald-600 dark:text-emerald-400', label: 'added' },
    modified: { letter: 'M', className: 'text-amber-600 dark:text-amber-400', label: 'modified' },
    deleted: { letter: 'D', className: 'text-red-600 dark:text-red-400', label: 'deleted' },
    renamed: { letter: 'R', className: 'text-sky-600 dark:text-sky-400', label: 'moved' },
};

export function ChangeLabel({ change }: { change: Change }) {
    const s = STATUS[change.status];
    return (
        <span className="flex min-w-0 items-center gap-2 text-sm">
            <span className={cn('w-3 shrink-0 font-mono text-xs font-bold', s.className)} title={s.label}>
                {s.letter}
            </span>
            <span className="min-w-0 truncate font-mono text-xs">
                {change.from ? (
                    <>
                        <span className="text-muted-foreground line-through">{rel(change.from)}</span> → {rel(change.path)}
                    </>
                ) : (
                    rel(change.path)
                )}
            </span>
        </span>
    );
}

export function Pill({
    children,
    tone = 'muted',
    className,
    title,
}: {
    children: ReactNode;
    tone?: 'muted' | 'ok' | 'warn' | 'bad' | 'info';
    className?: string;
    title?: string;
}) {
    return (
        <span
            title={title}
            className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs',
                tone === 'muted' && 'bg-muted text-muted-foreground',
                tone === 'ok' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
                tone === 'warn' && 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
                tone === 'bad' && 'bg-red-500/15 text-red-700 dark:text-red-400',
                tone === 'info' && 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
                className,
            )}
        >
            {children}
        </span>
    );
}

export function Sha({ sha }: { sha: string | null | undefined }) {
    return <span className="font-mono text-xs text-muted-foreground">{sha ?? '-'}</span>;
}

export function Banner({
    tone = 'warn',
    children,
    className,
}: {
    tone?: 'warn' | 'bad' | 'info';
    children: ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                'rounded-lg border px-3 py-2 text-sm',
                tone === 'warn' && 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200',
                tone === 'bad' && 'border-red-500/40 bg-red-500/10 text-red-900 dark:text-red-200',
                tone === 'info' && 'border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-200',
                className,
            )}
        >
            {children}
        </div>
    );
}

export const when = (at: number) => new Date(at).toISOString().slice(5, 16).replace('T', ' ');
