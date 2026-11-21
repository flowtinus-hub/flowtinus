import { useEffect, useState } from 'react';
import { CircleCheck, GitMerge, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CHANGES_CHANGED, getUpdateStatus, updateBranch, type UpdateOutcome, type UpdateStatus } from '@/data/git/git-api';
import type { ApiError } from '@/lib/api';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const shortPath = (handle: string, path: string) => (path.startsWith(`${handle}/`) ? path.slice(handle.length + 1) : path);

export function UpdateDialog({ handle, onClose }: { handle: string; onClose: () => void }) {
    const [status, setStatus] = useState<{ value?: UpdateStatus; error?: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<UpdateOutcome | null>(null);
    const [error, setError] = useState<ApiError | null>(null);

    useEffect(() => {
        let gone = false;
        void getUpdateStatus(handle).then(
            answer => !gone && setStatus(answer.ok ? { value: answer.value } : { error: answer.error.message }),
        );
        return () => {
            gone = true;
        };
    }, [handle]);

    const update = async () => {
        setBusy(true);
        setError(null);
        const result = await updateBranch(handle);
        setBusy(false);
        if (result.ok) {
            setOutcome(result.value);
            window.dispatchEvent(new Event(CHANGES_CHANGED));
        } else {
            setError(result.error);
        }
    };

    const value = status?.value;
    return (
        <Dialog open onOpenChange={open => !open && !busy && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Update</DialogTitle>
                    <DialogDescription>
                        Merges {value ? <span className="font-mono">{value.environment}</span> : "the environment's branch"} into{' '}
                        {value ? <span className="font-mono">{value.branch}</span> : 'this branch'}: a merge commit, pushed at once when
                        nothing conflicts.
                    </DialogDescription>
                </DialogHeader>
                {!status && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <LoaderCircle className="size-4 animate-spin" /> Checking the branches on the remote...
                    </p>
                )}
                {status?.error && <p className="text-sm text-destructive">{status.error}</p>}
                {value && !outcome && (
                    <div className="grid gap-2 text-sm">
                        {value.pending ? (
                            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                                A merge of <span className="font-mono">{value.pending.from}</span> is pending: Commit it whole from Changes,
                                or Discard all there to abort it.
                            </p>
                        ) : value.behind === 0 ? (
                            <p className="text-muted-foreground">
                                <span className="font-mono">{value.branch}</span> has every commit of{' '}
                                <span className="font-mono">{value.environment}</span>.
                            </p>
                        ) : (
                            <p>
                                <span className="font-mono">{value.branch}</span> is {plural(value.behind, 'commit')} behind{' '}
                                <span className="font-mono">{value.environment}</span>.
                            </p>
                        )}
                    </div>
                )}
                {outcome?.outcome === 'up-to-date' && <p className="text-sm text-muted-foreground">Already up to date.</p>}
                {outcome?.outcome === 'merged' && (
                    <p className="flex items-center gap-2 text-sm">
                        <CircleCheck className="size-4 text-emerald-600" />
                        <span>
                            Merged and pushed: <span className="font-mono">{outcome.commit.slice(0, 7)}</span>
                        </span>
                    </p>
                )}
                {outcome?.outcome === 'pending' && (
                    <div className="grid gap-2 text-sm">
                        <p>
                            {outcome.conflicts.length > 0
                                ? `${plural(outcome.conflicts.length, 'file')} conflict. The merge is pending: discard a conflicted file to keep this branch's version, then Commit the whole merge from Changes; Discard all aborts it.`
                                : 'The merge has no conflict but would not be valid. It is pending: fix the files, then Commit the whole merge from Changes; Discard all aborts it.'}
                        </p>
                        <ul className="grid gap-1">
                            {outcome.conflicts.map(path => (
                                <li key={path} className="font-mono text-xs text-red-700 dark:text-red-400">
                                    {shortPath(handle, path)}
                                </li>
                            ))}
                            {Object.entries(outcome.errors ?? {}).map(([path, errors]) => (
                                <li key={path} className="grid">
                                    <span className="font-mono text-xs">{shortPath(handle, path)}</span>
                                    <span className="text-xs whitespace-pre-line text-destructive">{errors}</span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {error && (
                    <div className="grid gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
                        <span>{error.message}</span>
                        {Object.entries(error.fields ?? {}).map(([path, why]) => (
                            <span key={path} className="grid">
                                <span className="font-mono text-xs">{shortPath(handle, path)}</span>
                                <span className="text-xs">{why}</span>
                            </span>
                        ))}
                    </div>
                )}
                <DialogFooter>
                    <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                        Close
                    </Button>
                    {value && !value.pending && value.behind > 0 && !outcome && (
                        <Button disabled={busy} onClick={() => void update()}>
                            {busy ? <LoaderCircle className="animate-spin" /> : <GitMerge />}
                            {busy ? 'Merging…' : `Update from ${value.environment}`}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
