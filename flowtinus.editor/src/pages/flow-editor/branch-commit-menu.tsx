import { CircleCheck, GitCommitHorizontal, LoaderCircle, Lock } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { CHANGES_CHANGED, commitChanges, getChanges, getCurrentBranch, removedBranchText, requiredBy, type WorkingChange } from '@/data/git/git-api';
import { useUnsavedWork } from '@/data/git/unsaved-work';
import type { ApiError } from '@/lib/api';

type Props = {
    flowId: string;
    workspace: string;
    disabled: boolean;
    flush: () => Promise<string>;
};

const NOT_A_DEPLOY = 'No deploy';

/** on a work branch: the canvas's Commit takes this flow's file to the branch; nothing is deployed */
export function BranchCommitMenu({ flowId, workspace, disabled, flush }: Props) {
    const [branch, setBranch] = useState<{ workspace: string; name: string } | null>(null);
    const [open, setOpen] = useState(false);
    const [preparing, setPreparing] = useState(false);
    const unsaved = useUnsavedWork();
    useEffect(() => {
        let gone = false;
        void getCurrentBranch(workspace).then(
            result => !gone && result.ok && result.value.branch && setBranch({ workspace, name: result.value.branch }),
        );
        return () => {
            gone = true;
        };
    }, [workspace]);

    const name = branch?.workspace === workspace ? branch.name : null;
    const start = async () => {
        setPreparing(true);
        await flush();
        setPreparing(false);
        setOpen(true);
    };

    return (
        <>
            <Button
                variant="outline"
                size="sm"
                className="bg-card shadow-md disabled:pointer-events-auto disabled:cursor-not-allowed"
                disabled={disabled || !name || preparing || !!unsaved}
                aria-label={`Commit to ${name ?? 'the branch'}, no deploy`}
                title={
                    unsaved
                        ? `${unsaved} to commit`
                        : `Commits this flow to ${name ?? 'the branch'}. Nothing is deployed: a pull request takes it to the environment.`
                }
                onClick={() => void start()}
            >
                {preparing ? <LoaderCircle className="animate-spin" /> : <GitCommitHorizontal />}
                Commit to {name ?? '…'}
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{NOT_A_DEPLOY}</span>
            </Button>
            {open && name && <CommitFlowDialog flowId={flowId} workspace={workspace} branch={name} onClose={() => setOpen(false)} />}
        </>
    );
}

function CommitFlowDialog({
    flowId,
    workspace,
    branch,
    onClose,
}: {
    flowId: string;
    workspace: string;
    branch: string;
    onClose: () => void;
}) {
    const [loaded, setLoaded] = useState<{ changes: WorkingChange[]; merging: boolean; removed: { lostTip: boolean } | null } | null>(null);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const [committed, setCommitted] = useState<string | null>(null);

    useEffect(() => {
        void getChanges(workspace).then(result => {
            if (result.ok) {
                setLoaded({
                    changes: result.value.changes,
                    merging: !!result.value.merge,
                    removed: result.value.removed ? { lostTip: !!result.value.lostTip } : null,
                });
            } else {
                setError(result.error);
            }
        });
    }, [workspace]);

    const own = loaded?.changes.find(c => c.fileId === flowId) ?? null;
    const locked = useMemo(() => (own ? requiredBy(loaded?.changes ?? [], new Set([own.path])) : new Map<string, string>()), [loaded, own]);
    const files = own ? [own, ...(loaded?.changes ?? []).filter(c => locked.has(c.path))] : [];
    const conflicted = files.filter(c => c.conflict);
    const blocked = loaded?.merging
        ? 'A merge is pending on this branch: it is committed whole, from Changes.'
        : loaded?.removed
          ? removedBranchText(loaded.removed.lostTip)
          : conflicted.length > 0
            ? `${conflicted.map(c => c.path).join(', ')} conflicts with git: resolve it from Changes first.`
            : null;

    const commit = async () => {
        setBusy(true);
        setError(null);
        const result = await commitChanges(
            workspace,
            files.map(c => c.path),
            message.trim(),
        );
        setBusy(false);
        if (result.ok) {
            setCommitted(result.value.commit);
            window.dispatchEvent(new Event(CHANGES_CHANGED));
        } else {
            setError(result.error);
        }
    };

    return (
        <Dialog open onOpenChange={isOpen => !isOpen && !busy && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Commit to {branch}</DialogTitle>
                </DialogHeader>
                {committed ? (
                    <p className="flex items-center gap-2 text-sm">
                        <CircleCheck className="size-4 text-emerald-600" />
                        <span>
                            <span className="font-mono">{committed.slice(0, 7)}</span> committed to{' '}
                            <span className="font-mono">{branch}</span>, not deployed
                        </span>
                    </p>
                ) : loaded === null && !error ? (
                    <LoaderCircle className="animate-spin" />
                ) : loaded && !own ? (
                    <p className="text-sm text-muted-foreground">Nothing to commit</p>
                ) : (
                    loaded && (
                        <>
                            <ul className="grid gap-1 text-sm">
                                {files.map(c => (
                                    <li key={c.path} className="grid">
                                        <span className="truncate font-mono text-xs">{c.path}</span>
                                        {locked.get(c.path) && (
                                            <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                                <Lock className="size-3" />
                                                {locked.get(c.path)}
                                            </span>
                                        )}
                                    </li>
                                ))}
                            </ul>
                            {blocked ? (
                                <p className="text-xs text-destructive">{blocked}</p>
                            ) : (
                                <Input
                                    aria-label="Commit message"
                                    placeholder="Commit message"
                                    value={message}
                                    disabled={busy}
                                    onChange={e => setMessage(e.target.value)}
                                />
                            )}
                        </>
                    )
                )}
                {error && (
                    <div className="grid gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
                        <span>{error.message}</span>
                        {Object.entries(error.fields ?? {}).map(([file, errors]) => (
                            <span key={file} className="grid">
                                <span className="font-mono text-xs">{file}</span>
                                <span className="text-xs whitespace-pre-line">{errors}</span>
                            </span>
                        ))}
                    </div>
                )}
                <DialogFooter>
                    {committed || (loaded && !own) ? (
                        <Button onClick={onClose}>Close</Button>
                    ) : (
                        <>
                            <Button variant="outline" disabled={busy} onClick={onClose}>
                                Cancel
                            </Button>
                            <Button disabled={busy || !own || !!blocked || !message.trim()} onClick={() => void commit()}>
                                {busy ? <LoaderCircle className="animate-spin" /> : <GitCommitHorizontal />}
                                {busy ? 'Committing…' : `Commit ${files.length}, no deploy`}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
