import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CircleCheck, GitCommitHorizontal, Lock, LoaderCircle, TriangleAlert, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { CHANGES_CHANGED, commitChanges, discardChanges, getChanges, type PendingMerge, type WorkingChange } from '@/data/git/git-api';
import type { ApiError } from '@/lib/api';
import { ConflictDialog } from './conflict-dialog';
import { FileDiffView } from './file-diff';

const CHANGE_LABEL: Record<WorkingChange['change'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

/** the path inside the workspace (the repository's path starts with its slug) */
const shortPath = (slug: string, path: string) => (path.startsWith(`${slug}/`) ? path.slice(slug.length + 1) : path);

/** what the chosen changes need, whatever that needs in turn: path → the reason */
function requiredBy(changes: WorkingChange[], chosen: Set<string>): Map<string, string> {
    const byPath = new Map(changes.map(c => [c.path, c]));
    const locked = new Map<string, string>();
    const queue = [...chosen];
    while (queue.length > 0) {
        for (const { path, reason } of byPath.get(queue.shift()!)?.requires ?? []) {
            if (!locked.has(path) && !chosen.has(path)) {
                locked.set(path, reason);
                queue.push(path);
            }
        }
    }
    return locked;
}

/**
 * The working copy's changes and the Commit: one's own checked, a teammate's unchecked with its editor (check it on
 * purpose); what the checked ones need checked and locked, with the reason. Discard per file, or all one's own.
 */
export function ChangesDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
    const [changes, setChanges] = useState<WorkingChange[] | null>(null);
    const [merge, setMerge] = useState<PendingMerge | null>(null);
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const [committed, setCommitted] = useState<string | null>(null);
    const [resolving, setResolving] = useState<string | null>(null);
    const [diffOf, setDiffOf] = useState<string | null>(null);
    const [loads, setLoads] = useState(0);

    const load = useCallback(async () => {
        const result = await getChanges(slug);
        if (result.ok) {
            setLoads(n => n + 1);
            const pending = result.value.merge ?? null;
            setChanges(result.value.changes);
            setMerge(pending);
            setChosen(new Set(result.value.changes.filter(c => (pending ? true : c.mine && !c.conflict)).map(c => c.path)));
            if (pending) {
                setMessage(current => current || `Merge ${pending.from}`);
            }
        } else {
            setError(result.error);
        }
    }, [slug]);
    useEffect(() => {
        void load();
    }, [load]);

    const locked = useMemo(() => requiredBy(changes ?? [], chosen), [changes, chosen]);
    // a pending merge is committed whole: every file, whatever is checked
    const all = merge ? (changes ?? []).map(c => c.path) : [...chosen, ...locked.keys()];
    const conflicted = (changes ?? []).filter(c => c.conflict && all.includes(c.path));

    const changed = () => window.dispatchEvent(new Event(CHANGES_CHANGED));
    const commit = async () => {
        setBusy(true);
        setError(null);
        const result = await commitChanges(slug, all, message.trim());
        setBusy(false);
        if (result.ok) {
            setCommitted(result.value.commit);
            changed();
        } else {
            setError(result.error);
        }
    };
    const discard = async (which: { paths: string[] } | { mine: true }) => {
        setBusy(true);
        setError(null);
        const result = await discardChanges(slug, which);
        setBusy(false);
        if (result.ok) {
            changed();
            await load();
        } else {
            setError(result.error);
        }
    };
    const toggle = (path: string, on: boolean) =>
        setChosen(current => {
            const next = new Set(current);
            if (on) {
                next.add(path);
            } else {
                next.delete(path);
            }
            return next;
        });

    return (
        <Dialog open onOpenChange={isOpen => !isOpen && !busy && onClose()}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Changes</DialogTitle>
                    <DialogDescription>
                        What is not committed yet on the environment&apos;s branch. A Commit takes the files checked to the branch, and the
                        server applies it.
                    </DialogDescription>
                </DialogHeader>
                {committed ? (
                    <p className="flex items-center gap-2 text-sm">
                        <CircleCheck className="size-4 text-emerald-600" />
                        <span>
                            <span className="font-mono">{committed.slice(0, 7)}</span> applied
                        </span>
                    </p>
                ) : changes === null ? (
                    <LoaderCircle className="animate-spin" />
                ) : changes.length === 0 && !merge ? (
                    <p className="text-sm text-muted-foreground">Nothing to commit: the branch has every change.</p>
                ) : (
                    <>
                        {merge && (
                            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                                A merge of <span className="font-mono">{merge.from}</span> ({merge.theirs.slice(0, 7)}) is pending. Commit
                                takes every file as one merge commit; Abort the merge puts the branch back as it was.
                                {merge.conflicts.length > 0 && ' Discard a conflicted file to keep this branch’s version of it.'}
                            </p>
                        )}
                        <ul className="grid max-h-[60vh] gap-1 overflow-y-auto text-sm">
                            {changes.map(change => {
                                const reason = locked.get(change.path);
                                return (
                                    <li key={change.path} className="grid gap-1">
                                        <div className="flex items-start gap-2">
                                            <input
                                                type="checkbox"
                                                className="mt-1"
                                                aria-label={shortPath(slug, change.path)}
                                                checked={!!merge || chosen.has(change.path) || !!reason}
                                                disabled={busy || !!merge || !!reason || !!change.conflict}
                                                onChange={e => toggle(change.path, e.target.checked)}
                                            />
                                            <span className="w-4 font-mono text-xs text-muted-foreground" title={change.change}>
                                                {CHANGE_LABEL[change.change]}
                                            </span>
                                            <span className="grid min-w-0 flex-1">
                                                <button
                                                    type="button"
                                                    className="flex min-w-0 items-center gap-1 text-left hover:underline"
                                                    title={diffOf === change.path ? 'Hide the diff' : 'Show the diff'}
                                                    aria-expanded={diffOf === change.path}
                                                    onClick={() => setDiffOf(diffOf === change.path ? null : change.path)}
                                                >
                                                    {diffOf === change.path ? (
                                                        <ChevronDown className="size-3 shrink-0" />
                                                    ) : (
                                                        <ChevronRight className="size-3 shrink-0" />
                                                    )}
                                                    <span className="truncate font-mono text-xs">
                                                        {change.from && `${shortPath(slug, change.from)} → `}
                                                        {shortPath(slug, change.path)}
                                                    </span>
                                                </button>
                                                {!change.mine && (
                                                    <span className="text-xs text-muted-foreground">
                                                        edited by {change.editedByName ?? change.editedBy ?? 'someone else'}
                                                    </span>
                                                )}
                                                {reason && (
                                                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                                        <Lock className="size-3" />
                                                        {reason}
                                                    </span>
                                                )}
                                                {change.conflict && (
                                                    <span className="text-xs text-red-700 dark:text-red-400">
                                                        conflicts with {change.conflict.slice(0, 7)}: resolve or discard it first
                                                    </span>
                                                )}
                                            </span>
                                            {change.conflict && (
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-7 border-amber-500/60"
                                                    disabled={busy}
                                                    onClick={() => setResolving(change.path)}
                                                >
                                                    <TriangleAlert className="text-amber-500" /> Resolve
                                                </Button>
                                            )}
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="size-7"
                                                title="Discard this change"
                                                disabled={busy}
                                                onClick={() => void discard({ paths: [change.path] })}
                                            >
                                                <Undo2 />
                                            </Button>
                                        </div>
                                        {diffOf === change.path && (
                                            <FileDiffView key={loads} slug={slug} path={change.path} className="ml-6" />
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                        <Input
                            aria-label="Commit message"
                            placeholder="Commit message"
                            value={message}
                            disabled={busy}
                            onChange={e => setMessage(e.target.value)}
                        />
                    </>
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
                    {committed || (!changes?.length && !merge) ? (
                        <Button onClick={onClose}>Close</Button>
                    ) : (
                        <>
                            <Button
                                variant="outline"
                                disabled={busy || (!merge && !changes?.some(c => c.mine))}
                                onClick={() => void discard({ mine: true })}
                            >
                                {merge ? 'Abort the merge' : 'Discard all mine'}
                            </Button>
                            <Button
                                disabled={busy || (all.length === 0 && !merge) || !message.trim() || conflicted.length > 0}
                                onClick={() => void commit()}
                            >
                                {busy ? <LoaderCircle className="animate-spin" /> : <GitCommitHorizontal />}
                                {busy ? 'Committing…' : `Commit ${all.length}`}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
            {resolving && <ConflictDialog slug={slug} path={resolving} onClose={() => setResolving(null)} onResolved={() => void load()} />}
        </Dialog>
    );
}
