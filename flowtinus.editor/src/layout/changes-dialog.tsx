import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CircleCheck, File, FileCode2, Folder, FolderKanban, GitCommitHorizontal, Lock, LoaderCircle, Plug, TriangleAlert, Undo2, Workflow, type LucideIcon } from 'lucide-react';
import { ArrivedDisabledList } from '@/components/arrived-disabled-list';
import { WarningLine } from '@/components/warning-line';
import { ConfirmDialog, type ConfirmTarget } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { CHANGES_CHANGED, commitChanges, discardChanges, getChanges, getCurrentBranch, getGitStatus, discardedWith, removedBranchText, requiredBy, type ArrivedDisabled, type PendingMerge, type WorkingChange } from '@/data/git/git-api';
import { useMe, useWorkspace } from '@/data/workspaces/use-workspace';
import { useUnsavedWork } from '@/data/git/unsaved-work';
import type { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ConflictDialog } from './conflict-dialog';
import { CreateBranchDialog } from './create-branch-dialog';
import { FileDiffView } from './file-diff';

/** as VS Code shows a file's change: its letter, in its color, the word on hover */
const CHANGE_MARK: Record<WorkingChange['change'], { letter: string; word: string; className: string }> = {
    added: { letter: 'A', word: 'Added', className: 'text-emerald-600 dark:text-emerald-400' },
    modified: { letter: 'M', word: 'Modified', className: 'text-amber-600 dark:text-amber-400' },
    deleted: { letter: 'D', word: 'Deleted', className: 'text-red-600 dark:text-red-400' },
    renamed: { letter: 'R', word: 'Renamed', className: 'text-sky-600 dark:text-sky-400' },
};

const KIND_ICON: Record<string, LucideIcon> = {
    flow: Workflow,
    script: FileCode2,
    folder: Folder,
    project: FolderKanban,
    connection: Plug,
};

/** the file's name, and the folders it is in */
const splitPath = (path: string) => {
    const at = path.lastIndexOf('/');
    return at < 0 ? { name: path, folder: '' } : { name: path.slice(at + 1), folder: path.slice(0, at) };
};

const shortPath = (handle: string, path: string) => (path.startsWith(`${handle}/`) ? path.slice(handle.length + 1) : path);

export function ChangesDialog({ handle, onClose }: { handle: string; onClose: () => void }) {
    const [changes, setChanges] = useState<WorkingChange[] | null>(null);
    const [merge, setMerge] = useState<PendingMerge | null>(null);
    const [removed, setRemoved] = useState<{ lostTip: boolean } | null>(null);
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const [committed, setCommitted] = useState<{ commit: string; arrived: ArrivedDisabled[] } | null>(null);
    const [resolving, setResolving] = useState<string | null>(null);
    const [diffOf, setDiffOf] = useState<string | null>(null);
    const [loads, setLoads] = useState(0);
    const [pullRequestsOnly, setPullRequestsOnly] = useState<string | null>(null);
    const [workBranch, setWorkBranch] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
    const { canEdit } = useWorkspace();
    const unsaved = useUnsavedWork();
    const { state: me } = useMe();
    const userHandle = me.status === 'ready' ? me.me.handle : null;
    useEffect(() => {
        void Promise.all([getCurrentBranch(handle), getGitStatus(handle)]).then(([result, status]) => {
            setPullRequestsOnly(result.ok && result.value.offersBranch && result.value.branch ? result.value.branch : null);
            const branch = result.ok ? result.value.branch : null;
            setWorkBranch(branch && status.ok && status.value.on && status.value.branch !== branch ? branch : null);
        });
    }, [handle]);

    const load = useCallback(async () => {
        const result = await getChanges(handle);
        if (result.ok) {
            setLoads(n => n + 1);
            const pending = result.value.merge ?? null;
            setChanges(result.value.changes);
            setMerge(pending);
            setRemoved(result.value.removed ? { lostTip: !!result.value.lostTip } : null);
            setChosen(new Set(result.value.changes.filter(c => (pending ? true : c.mine && !c.conflict)).map(c => c.path)));
            if (pending) {
                setMessage(current => current || `Merge ${pending.from}`);
            }
        } else {
            setError(result.error);
        }
    }, [handle]);
    useEffect(() => {
        void load();
    }, [load]);

    const locked = useMemo(() => requiredBy(changes ?? [], chosen), [changes, chosen]);
    // a pending merge is committed whole: every file, whatever is checked
    const all = merge ? (changes ?? []).map(c => c.path) : [...chosen, ...locked.keys()];
    const conflicted = (changes ?? []).filter(c => c.conflict && all.includes(c.path));
    const endings = (changes ?? []).flatMap(c => (c.endsEmergencyRollback && all.includes(c.path) ? [c.endsEmergencyRollback] : []));
    const pickable = (changes ?? []).filter(c => !c.conflict && !locked.has(c.path)).map(c => c.path);
    const pickedCount = pickable.filter(path => chosen.has(path)).length;
    const allPicked: boolean | 'indeterminate' =
        merge || (pickable.length > 0 && pickedCount === pickable.length) ? true : pickedCount > 0 ? 'indeterminate' : false;
    const pickAll = (on: boolean) => setChosen(on ? new Set(pickable) : new Set());

    const changed = () => window.dispatchEvent(new Event(CHANGES_CHANGED));
    const commit = async () => {
        setBusy(true);
        setError(null);
        const result = await commitChanges(handle, all, message.trim());
        setBusy(false);
        if (result.ok) {
            setCommitted(result.value);
            changed();
        } else {
            setError(result.error);
        }
    };
    const discard = (which: { paths: string[] } | { mine: true }) => {
        const along = 'paths' in which ? discardedWith(changes ?? [], which.paths[0]!).map(path => shortPath(handle, path)) : [];
        setConfirm({
            title:
                'paths' in which
                    ? `Discard the changes of ${shortPath(handle, which.paths[0]!)}?`
                    : merge
                      ? 'Abort the merge?'
                      : 'Discard all your changes?',
            description:
                'paths' in which
                    ? `The file takes git's content; its changes are lost.${along.length > 0 ? ` These go too, as they need it: ${along.join(', ')}.` : ''}`
                    : merge
                      ? 'The branch goes back to how it was before the merge; every file of the merge is lost.'
                      : "Every file you changed takes git's content; your changes are lost.",
            confirmLabel: 'paths' in which ? 'Discard changes' : merge ? 'Abort the merge' : 'Discard all mine',
            busyLabel: merge && !('paths' in which) ? 'Aborting…' : 'Discarding…',
            destructive: true,
            onConfirm: async () => {
                const result = await discardChanges(handle, which);
                if (result.ok) {
                    changed();
                    await load();
                }
                return result;
            },
        });
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
                        {workBranch ? (
                            <>
                                What is not committed yet on <span className="font-mono">{workBranch}</span>. A Commit pushes the files
                                checked to that branch; nothing is applied here until it is merged into the environment&apos;s branch.
                            </>
                        ) : (
                            <>
                                What is not committed yet on the environment&apos;s branch. A Commit takes the files checked to the branch,
                                and the server applies it.
                            </>
                        )}
                    </DialogDescription>
                </DialogHeader>
                {committed ? (
                    <div className="grid gap-3">
                        <p className="flex items-center gap-2 text-sm">
                            <CircleCheck className="size-4 text-emerald-600" />
                            <span>
                                <span className="font-mono">{committed.commit.slice(0, 7)}</span>{' '}
                                {workBranch ? (
                                    <>
                                        pushed to <span className="font-mono">{workBranch}</span>
                                    </>
                                ) : (
                                    'applied'
                                )}
                            </span>
                        </p>
                        {committed.arrived.length > 0 && (
                            <div className="grid gap-2">
                                <p className="text-sm text-muted-foreground">
                                    These triggers arrived disabled: none runs until it is turned on in this environment.
                                </p>
                                <ArrivedDisabledList handle={handle} items={committed.arrived} className="max-h-[50vh] overflow-y-auto" />
                            </div>
                        )}
                    </div>
                ) : changes === null ? (
                    <LoaderCircle className="animate-spin" />
                ) : changes.length === 0 && !merge ? (
                    <p className="text-sm text-muted-foreground">Nothing to commit: the branch has every change.</p>
                ) : (
                    <>
                        {removed && (
                            <p className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
                                {removedBranchText(removed.lostTip)}
                            </p>
                        )}
                        {merge && (
                            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                                A merge of <span className="font-mono">{merge.from}</span> ({merge.theirs.slice(0, 7)}) is pending. Commit
                                takes every file as one merge commit; Abort the merge puts the branch back as it was.
                                {merge.conflicts.length > 0 &&
                                    ' Resolve a conflicted file to choose what it keeps, or discard it to keep this branch’s version.'}
                            </p>
                        )}
                        <div className="grid min-w-0 gap-1">
                            <div className="flex items-center gap-2 border-b px-2 pb-2 text-xs text-muted-foreground">
                                <Checkbox
                                    aria-label="Select all"
                                    checked={allPicked}
                                    disabled={busy || !!merge || pickable.length === 0}
                                    onCheckedChange={checked => pickAll(checked === true)}
                                />
                                <span className="font-medium tracking-wide uppercase">Changes</span>
                                <span className="rounded-full bg-muted px-1.5 font-medium text-foreground">{changes.length}</span>
                                <span className="ml-auto">{all.length} to commit</span>
                            </div>
                            <ul className="grid max-h-[60vh] min-w-0 overflow-x-hidden overflow-y-auto text-sm">
                                {changes.map(change => {
                                    const reason = locked.get(change.path);
                                    const mark = CHANGE_MARK[change.change];
                                    const Icon = KIND_ICON[change.kind] ?? File;
                                    const { name, folder } = splitPath(shortPath(handle, change.path));
                                    const open = diffOf === change.path;
                                    return (
                                        <li key={change.path} className="grid min-w-0">
                                            <div
                                                role="button"
                                                tabIndex={0}
                                                aria-expanded={open}
                                                title={`${shortPath(handle, change.path)} · ${mark.word}${open ? '' : ' · click to show the diff'}`}
                                                className="group flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 outline-none hover:bg-accent focus-visible:bg-accent"
                                                onClick={() => setDiffOf(open ? null : change.path)}
                                                onKeyDown={event => {
                                                    if (event.key === 'Enter' || event.key === ' ') {
                                                        event.preventDefault();
                                                        setDiffOf(open ? null : change.path);
                                                    }
                                                }}
                                            >
                                                <Checkbox
                                                    aria-label={shortPath(handle, change.path)}
                                                    checked={!!merge || chosen.has(change.path) || !!reason}
                                                    disabled={busy || !!merge || !!reason || !!change.conflict}
                                                    onClick={event => event.stopPropagation()}
                                                    onCheckedChange={checked => toggle(change.path, checked === true)}
                                                />
                                                {open ? (
                                                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                                                ) : (
                                                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                                )}
                                                <Icon className="size-4 shrink-0 text-muted-foreground" />
                                                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                                                    <span
                                                        className={cn(
                                                            'max-w-full shrink truncate',
                                                            change.change === 'deleted' && 'line-through',
                                                        )}
                                                    >
                                                        {name}
                                                    </span>
                                                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                                        {change.from && `${shortPath(handle, change.from)} → `}
                                                        {folder}
                                                    </span>
                                                </span>
                                                {!change.mine && (
                                                    <span className="shrink-0 text-xs text-muted-foreground">
                                                        {change.editedByName ?? change.editedBy ?? 'someone else'}
                                                    </span>
                                                )}
                                                {reason && <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label={reason} />}
                                                {change.conflict && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="h-6 border-amber-500/60 px-2 text-xs"
                                                        title={`Conflicts with ${change.conflict.slice(0, 7)}: resolve or discard it first`}
                                                        disabled={busy}
                                                        onClick={event => {
                                                            event.stopPropagation();
                                                            setResolving(change.path);
                                                        }}
                                                    >
                                                        <TriangleAlert className="text-amber-500" /> Resolve
                                                    </Button>
                                                )}
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="size-6 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 focus-visible:opacity-100"
                                                    title="Discard this change"
                                                    aria-label={`Discard the changes of ${shortPath(handle, change.path)}`}
                                                    disabled={busy}
                                                    onClick={event => {
                                                        event.stopPropagation();
                                                        discard({ paths: [change.path] });
                                                    }}
                                                >
                                                    <Undo2 />
                                                </Button>
                                                <span
                                                    className={cn(
                                                        'w-3 shrink-0 text-center font-mono text-xs font-semibold',
                                                        mark.className,
                                                    )}
                                                    title={mark.word}
                                                >
                                                    {mark.letter}
                                                </span>
                                            </div>
                                            {reason && (
                                                <span className="flex items-center gap-1 pl-14 text-xs text-muted-foreground">
                                                    <Lock className="size-3" />
                                                    {reason}
                                                </span>
                                            )}
                                            {open && <FileDiffView key={loads} handle={handle} path={change.path} className="my-1 ml-8" />}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                        {pullRequestsOnly ? (
                            <p className="text-xs text-muted-foreground">
                                <span className="font-mono">{pullRequestsOnly}</span> only takes pull requests: nothing is committed here.
                                Discard changes, or create a branch of your own and take yours there.
                            </p>
                        ) : (
                            <>
                                {endings.map(ending => (
                                    <WarningLine key={ending}>{ending}</WarningLine>
                                ))}
                                <Input
                                    aria-label="Commit message"
                                    placeholder="Commit message"
                                    value={message}
                                    disabled={busy}
                                    onChange={e => setMessage(e.target.value)}
                                />
                            </>
                        )}
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
                                onClick={() => discard({ mine: true })}
                            >
                                {merge ? 'Abort the merge' : 'Discard all mine'}
                            </Button>
                            {pullRequestsOnly && canEdit && userHandle && (
                                <Button variant="outline" disabled={busy} onClick={() => setCreating(true)}>
                                    Create branch...
                                </Button>
                            )}
                            <Button
                                disabled={
                                    busy ||
                                    !!unsaved ||
                                    !!removed ||
                                    !!pullRequestsOnly ||
                                    (all.length === 0 && !merge) ||
                                    !message.trim() ||
                                    conflicted.length > 0
                                }
                                title={
                                    pullRequestsOnly
                                        ? `${pullRequestsOnly} only takes pull requests: create a branch of your own to commit.`
                                        : (unsaved ?? undefined)
                                }
                                onClick={() => void commit()}
                            >
                                {busy ? <LoaderCircle className="animate-spin" /> : <GitCommitHorizontal />}
                                {busy ? 'Committing…' : merge ? 'Commit the merge' : `Commit ${all.length}`}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
            {creating && pullRequestsOnly && userHandle && (
                <CreateBranchDialog handle={handle} from={pullRequestsOnly} userHandle={userHandle} onClose={() => setCreating(false)} />
            )}
            {resolving && (
                <ConflictDialog handle={handle} path={resolving} onClose={() => setResolving(null)} onResolved={() => void load()} />
            )}
            <ConfirmDialog target={confirm} onClose={() => setConfirm(null)} />
        </Dialog>
    );
}
