import { useContext, useState } from 'react';
import { GitCommitHorizontal, GitPullRequestArrow, RefreshCw, Undo2 } from 'lucide-react';
import { Link } from 'react-router';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { behind, commitChanges, currentBranch, currentChanges, discard, editRefusal, openPr, resolveUpdate, server, type Conflict } from './actions';
import { BranchPicker, ChromeContext } from './branch-picker';
import { commitsBetween, isUserBranch, POSTGRES, type Change } from './model';
import { useStore } from './store';
import { Banner, ChangeLabel, DiffView, prRoute, rel, Sha } from './ui';

export function ChangesPanel() {
    const { state, act } = useStore();
    const { startUpdate } = useContext(ChromeContext);
    const s = server(state);
    const branch = currentBranch(state);
    const changes = currentChanges(state);
    const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
    const [open, setOpen] = useState<string | null>(null);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [discarding, setDiscarding] = useState<Change | null>(null);

    if (!s.gitOn || branch === POSTGRES) {
        return (
            <p className="text-sm text-muted-foreground">
                Git is off on {s.env}: there are no branches nor changes, the Deploy button deploys the draft.
            </p>
        );
    }

    const envBranch = s.settings.branch;
    const refusal = editRefusal(state);
    const behindCommits = behind(state);
    const ahead = branch === envBranch ? [] : commitsBetween(state, state.branches[envBranch], state.branches[branch]);
    const pr = state.prs.find(p => p.state === 'open' && p.from === branch);
    const chosen = changes.filter(c => !unchecked.has(c.key));
    const isEnv = branch === envBranch;

    const commit = () => {
        const problem = act(d =>
            commitChanges(
                d,
                chosen.map(c => c.key),
                message,
            ),
        );
        if (problem) {
            setError(problem);
        } else {
            setError('');
            setMessage('');
            setUnchecked(new Set());
        }
    };

    return (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">Branch</span>
                    <BranchPicker />
                    <Sha sha={state.branches[branch]} />
                </div>
                {isUserBranch(branch) && (
                    <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                        <span>
                            {ahead.length} commit{ahead.length === 1 ? '' : 's'} ahead, {behindCommits.length} behind {envBranch}
                        </span>
                        {!refusal && (
                            <Button size="xs" variant="outline" disabled={behindCommits.length === 0} onClick={startUpdate}>
                                <RefreshCw /> Update
                            </Button>
                        )}
                    </div>
                )}
            </div>
            {refusal && <Banner tone="bad">{refusal}</Banner>}

            <section className="grid grid-cols-[minmax(0,1fr)] gap-2">
                <h3 className="text-sm font-semibold">
                    Changes{' '}
                    <span className="font-normal text-muted-foreground">
                        ({changes.length}, the working copy in {s.env}'s Postgres)
                    </span>
                </h3>
                {changes.length === 0 && <p className="text-sm text-muted-foreground">Nothing changed since the last commit.</p>}
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-1">
                    {changes.map(change => (
                        <li key={change.key} className="rounded-md border">
                            <div className="flex items-center gap-2 px-2 py-1">
                                <input
                                    type="checkbox"
                                    aria-label={`Include ${change.path}`}
                                    checked={!unchecked.has(change.key)}
                                    onChange={e => {
                                        const next = new Set(unchecked);
                                        if (e.target.checked) {
                                            next.delete(change.key);
                                        } else {
                                            next.add(change.key);
                                        }
                                        setUnchecked(next);
                                    }}
                                />
                                <button
                                    type="button"
                                    className="min-w-0 flex-1 text-left"
                                    onClick={() => setOpen(open === change.key ? null : change.key)}
                                >
                                    <ChangeLabel change={change} />
                                </button>
                                <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    title="Discard (not one of the doc's five actions, but needed)"
                                    disabled={!!refusal}
                                    onClick={() => setDiscarding(change)}
                                >
                                    <Undo2 />
                                </Button>
                            </div>
                            {open === change.key && (
                                <DiffView className="m-2 mt-0" before={change.before ?? ''} after={change.after ?? ''} />
                            )}
                        </li>
                    ))}
                </ul>
            </section>

            {changes.length > 0 && !refusal && (
                <section className="grid gap-2">
                    <Textarea placeholder="Commit message" value={message} onChange={e => setMessage(e.target.value)} rows={2} />
                    {error && <p className="text-sm text-destructive">{error}</p>}
                    <Button onClick={commit} disabled={chosen.length === 0}>
                        <GitCommitHorizontal /> Commit {chosen.length} file{chosen.length === 1 ? '' : 's'} to {branch}
                        {isEnv && ` (deploys to ${s.env})`}
                    </Button>
                </section>
            )}

            {!isEnv && isUserBranch(branch) && (
                <section className="grid gap-2 border-t pt-3">
                    <h3 className="text-sm font-semibold">Pull request to {envBranch}</h3>
                    {ahead.map(c => (
                        <div key={c.sha} className="flex gap-2 text-xs">
                            <Sha sha={c.sha} /> <span className="truncate">{c.message}</span>
                        </div>
                    ))}
                    {pr ? (
                        <p className="text-sm">
                            PR{' '}
                            <Link className="text-primary underline" to={prRoute(pr.number)}>
                                !{pr.number}
                            </Link>{' '}
                            is open on the provider (it follows the branch: new commits go into it).
                        </p>
                    ) : (
                        <Button
                            variant="outline"
                            disabled={ahead.length === 0 || !!refusal}
                            onClick={() => act(d => openPr(d, 'change', branch, envBranch, ahead[ahead.length - 1]?.message ?? branch))}
                        >
                            <GitPullRequestArrow /> Open a PR to {envBranch}
                        </Button>
                    )}
                    {changes.length > 0 && <p className="text-xs text-muted-foreground">Uncommitted changes do not go in the PR.</p>}
                </section>
            )}

            <AlertDialog open={!!discarding} onOpenChange={o => !o && setDiscarding(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Discard this change?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {discarding && (
                                <>
                                    <span className="font-mono text-foreground">{rel(discarding.path)}</span>{' '}
                                    {discarding.status === 'added'
                                        ? 'is removed: it was never committed.'
                                        : discarding.status === 'deleted'
                                          ? `comes back as it is in the last commit of ${branch}.`
                                          : discarding.status === 'renamed'
                                            ? `goes back to ${rel(discarding.from ?? '')}, as it is in the last commit of ${branch}.`
                                            : `goes back to how it is in the last commit of ${branch}.`}{' '}
                                    {isEnv && `The working copy of ${branch} is shared: this may be someone else's change. `}
                                    This cannot be undone.
                                </>
                            )}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep it</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                if (discarding) {
                                    act(d => discard(d, [discarding.key]));
                                }
                                setDiscarding(null);
                            }}
                        >
                            Discard
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

export function ConflictDialog({ conflicts, onClose }: { conflicts: Conflict[] | null; onClose: () => void }) {
    const { state, act } = useStore();
    const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>({});
    const envBranch = server(state).settings.branch;
    return (
        <Dialog open={!!conflicts} onOpenChange={o => !o && onClose()}>
            <DialogContent className="sm:max-w-4xl">
                <DialogHeader>
                    <DialogTitle>Update: {conflicts?.length} conflict(s)</DialogTitle>
                    <DialogDescription>
                        {envBranch} and {currentBranch(state)} both changed these files. Choose a whole file per conflict: there is no merge
                        editor.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid max-h-[60vh] gap-4 overflow-auto">
                    {conflicts?.map(c => (
                        <div key={c.path} className="grid gap-2">
                            <div className="flex items-center gap-3">
                                <span className="flex-1 font-mono text-xs">{rel(c.path)}</span>
                                {(['mine', 'theirs'] as const).map(side => (
                                    <label
                                        key={side}
                                        className={cn('flex items-center gap-1 text-sm', choices[c.path] === side && 'font-semibold')}
                                    >
                                        <input
                                            type="radio"
                                            name={c.path}
                                            checked={choices[c.path] === side}
                                            onChange={() => setChoices({ ...choices, [c.path]: side })}
                                        />
                                        {side === 'mine' ? 'Mine' : `Theirs (${envBranch})`}
                                    </label>
                                ))}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <p className="text-xs text-muted-foreground">Mine vs base</p>
                                    <DiffView before={c.base} after={c.mine} />
                                </div>
                                <div>
                                    <p className="text-xs text-muted-foreground">Theirs vs base</p>
                                    <DiffView before={c.base} after={c.theirs} />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        disabled={!conflicts || conflicts.some(c => !choices[c.path])}
                        onClick={() => {
                            act(d => resolveUpdate(d, choices));
                            setChoices({});
                            onClose();
                        }}
                    >
                        Merge with these choices
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
