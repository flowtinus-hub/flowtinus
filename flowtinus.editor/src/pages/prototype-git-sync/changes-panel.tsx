import { useContext, useState } from 'react';
import { GitCommitHorizontal, GitPullRequestArrow, RefreshCw, TriangleAlert, Undo2 } from 'lucide-react';
import { Link } from 'react-router';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { behind, borrowedCommits, commitChanges, createBranch, currentBranch, currentChanges, discard, editRefusal, envBranch, fileMeta, openPr, resolveWorkingConflict, server, workingConflict } from './actions';
import { BranchPicker, ChromeContext } from './branch-picker';
import { branchKind, commitsBetween, FLOW_EXT, joinSegments, labelOf, POSTGRES, type Change, type HunkChoice, type Overlay, type TreeConflict } from './model';
import { useStore } from './store';
import { Banner, ChangeLabel, DiffView, NameDialog, Pill, prRoute, rel, Sha } from './ui';

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
    const [resolving, setResolving] = useState<string | null>(null);
    const [rescuing, setRescuing] = useState(false);

    if (!s.gitOn || branch === POSTGRES) {
        return (
            <p className="text-sm text-muted-foreground">
                Git is off on {s.env}: there are no branches nor changes, the Deploy button deploys the draft.
            </p>
        );
    }

    const env = envBranch(state);
    const removed = !state.branches[branch];
    const kind = removed ? 'removed' : branchKind(state, branch);
    const refusal = removed ? null : editRefusal(state);
    const behindCommits = behind(state);
    const ahead = removed || branch === env ? [] : commitsBetween(state, state.branches[env], state.branches[branch]);
    const pr = state.prs.find(p => p.state === 'open' && p.from === branch);
    const chosen = changes.filter(c => !unchecked.has(c.key));
    const isEnv = branch === env;
    const shared = isEnv || kind === 'shared';
    const borrowed = removed ? [] : borrowedCommits(state, branch, env);
    const pending = state.session.pendingMerge?.env === s.env ? state.session.pendingMerge : null;
    const conflict = resolving ? workingConflict(state, resolving) : null;
    const prKind = kind === 'hotfix' ? 'hotfix' : 'change';

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
                    <Pill>{kind === 'environment' ? `${labelOf(state, s.env)}'s branch` : kind}</Pill>
                </div>
                {!removed && !isEnv && kind !== 'backport' && (
                    <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                        <span>
                            {ahead.length} commit{ahead.length === 1 ? '' : 's'} ahead, {behindCommits.length} behind {env}
                        </span>
                        {!refusal && (
                            <Button size="xs" variant="outline" disabled={behindCommits.length === 0} onClick={startUpdate}>
                                <RefreshCw /> Update
                            </Button>
                        )}
                    </div>
                )}
            </div>
            {pending && (
                <Banner tone="warn">
                    {pending.message}: conflicts to resolve before the merge commit. The conflict screen is open; close it to cancel.
                </Banner>
            )}
            {removed && (
                <Banner tone="warn" className="grid gap-2">
                    <span>
                        <span className="font-mono">{branch}</span> was removed on the remote (merged, or deleted on the provider). Your{' '}
                        {changes.length} uncommitted change(s) on {s.env} are kept.
                    </span>
                    <span className="flex gap-2">
                        <Button size="xs" onClick={() => setRescuing(true)}>
                            New branch with these changes
                        </Button>
                        <Button
                            size="xs"
                            variant="outline"
                            onClick={() =>
                                act(d =>
                                    discard(
                                        d,
                                        changes.map(c => c.key),
                                    ),
                                )
                            }
                        >
                            Discard them
                        </Button>
                    </span>
                </Banner>
            )}
            {refusal && <Banner tone="bad">{refusal}</Banner>}

            <section className="grid grid-cols-[minmax(0,1fr)] gap-2">
                <h3 className="text-sm font-semibold">
                    Changes{' '}
                    <span className="font-normal text-muted-foreground">
                        ({changes.length}, the working copy in {s.env}'s Postgres)
                    </span>
                </h3>
                {shared && changes.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                        This working copy is shared. A new branch from here takes only the files you edited last.
                    </p>
                )}
                {changes.length === 0 && <p className="text-sm text-muted-foreground">Nothing changed since the last commit.</p>}
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-1">
                    {changes.map(change => {
                        const meta = fileMeta(state, change.path) ?? (change.from ? fileMeta(state, change.from) : undefined);
                        return (
                            <li key={change.key} className={cn('rounded-md border', meta?.conflict && 'border-amber-500/60')}>
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
                                    {shared && meta && meta.editor !== state.session.user && (
                                        <Pill title="Last edited by">
                                            {state.users.find(u => u.slug === meta.editor)?.name ?? meta.editor}
                                        </Pill>
                                    )}
                                    {meta?.conflict && (
                                        <Button
                                            size="xs"
                                            variant="outline"
                                            className="border-amber-500/60"
                                            onClick={() => setResolving(change.path)}
                                        >
                                            <TriangleAlert className="text-amber-500" /> Resolve
                                        </Button>
                                    )}
                                    <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        title="Discard"
                                        disabled={!!refusal}
                                        onClick={() => setDiscarding(change)}
                                    >
                                        <Undo2 />
                                    </Button>
                                </div>
                                {meta?.conflict && (
                                    <p className="px-2 pb-1 text-xs text-amber-700 dark:text-amber-400">
                                        {branch} moved and changed this file under your edit: resolve it before it can be committed.
                                    </p>
                                )}
                                {open === change.key && (
                                    <DiffView className="m-2 mt-0" before={change.before ?? ''} after={change.after ?? ''} />
                                )}
                            </li>
                        );
                    })}
                </ul>
            </section>

            {changes.length > 0 && !refusal && !removed && (
                <section className="grid gap-2">
                    <Textarea placeholder="Commit message" value={message} onChange={e => setMessage(e.target.value)} rows={2} />
                    {error && <p className="text-sm text-destructive">{error}</p>}
                    <Button onClick={commit} disabled={chosen.length === 0}>
                        <GitCommitHorizontal /> Commit {chosen.length} file{chosen.length === 1 ? '' : 's'} to {branch}
                        {isEnv && ` (deploys to ${s.env})`}
                    </Button>
                    <p className="text-xs text-muted-foreground">The workspace is validated as a whole before the commit.</p>
                </section>
            )}

            {!removed && !isEnv && (kind === 'user' || kind === 'shared' || kind === 'hotfix' || kind === 'backport') && (
                <section className="grid gap-2 border-t pt-3">
                    <h3 className="text-sm font-semibold">
                        {kind === 'hotfix' ? 'Hotfix pull request' : kind === 'backport' ? 'Backport pull request' : 'Pull request'} to{' '}
                        {env}
                    </h3>
                    {ahead.map(c => (
                        <div key={c.sha} className="flex gap-2 text-xs">
                            <Sha sha={c.sha} /> <span className="truncate">{c.message}</span>
                        </div>
                    ))}
                    {borrowed.map(b => (
                        <Banner key={b.branch} tone="warn">
                            This PR includes {b.count} commit{b.count === 1 ? '' : 's'} from <span className="font-mono">{b.branch}</span>{' '}
                            not yet in {env}: they leave the diff once that branch is merged.
                        </Banner>
                    ))}
                    {pr ? (
                        <p className="text-sm">
                            PR{' '}
                            <Link className="text-primary underline" to={prRoute(pr.number)}>
                                !{pr.number}
                            </Link>{' '}
                            is open on the provider (it follows the branch: new commits go into it).
                        </p>
                    ) : kind === 'backport' ? (
                        <p className="text-sm text-muted-foreground">The backport PR opens once its merge is committed.</p>
                    ) : (
                        <Button
                            variant="outline"
                            disabled={ahead.length === 0 || !!refusal}
                            onClick={() => act(d => openPr(d, prKind, branch, env, ahead[ahead.length - 1]?.message ?? branch))}
                        >
                            <GitPullRequestArrow /> Open a {prKind === 'hotfix' ? 'hotfix ' : ''}PR to {env}
                        </Button>
                    )}
                    {kind === 'hotfix' && (
                        <p className="text-xs text-muted-foreground">
                            Once merged, {s.env} is ahead of its source: promotions into {s.env} stay blocked until the hotfix is
                            back-ported.
                        </p>
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
                                    {discarding.path.includes('/connections/') &&
                                        'The connection stays in this environment; only its declaration goes. '}
                                    {shared && `The working copy of ${branch} is shared: this may be someone else's change. `}
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

            <ConflictDialog
                conflicts={conflict ? [conflict] : null}
                title={`${resolving ? rel(resolving) : ''}: your edit against what arrived`}
                description={`${branch} moved under your uncommitted edit. Resolve it per hunk; the result stays in your working copy.`}
                onCancel={() => setResolving(null)}
                onSubmit={resolution => {
                    act(d => resolveWorkingConflict(d, resolving!, resolution[resolving!] ?? null));
                    setResolving(null);
                    return null;
                }}
            />

            <NameDialog
                open={rescuing}
                title="New branch with these changes"
                description={`Cut from ${env}; the kept changes go to it.`}
                label="Name"
                prefix={`users/${state.session.user}/`}
                confirm="Create and switch"
                onClose={() => setRescuing(false)}
                onSubmit={name => act(d => createBranch(d, name, env))}
            />
        </div>
    );
}

// ---------- the conflict screen: per hunk, and a choice for what is not content ----------

type Pick = { hunks?: HunkChoice[]; keep?: boolean; path?: 'mine' | 'theirs'; rename?: string };

function resolutionOf(conflict: TreeConflict, pick: Pick | undefined): Overlay | null {
    switch (conflict.kind) {
        case 'content': {
            const count = conflict.segments.filter(x => x.kind === 'conflict').length;
            const hunks = pick?.hunks ?? [];
            if (hunks.filter(Boolean).length < count) {
                return null;
            }
            return { [conflict.path]: joinSegments(conflict.segments, hunks) };
        }
        case 'modify-delete':
            return pick?.keep === undefined ? null : { [conflict.path]: pick.keep ? conflict.content : null };
        case 'add-add': {
            const name = pick?.rename?.trim();
            if (!name) {
                return null;
            }
            const dir = conflict.path.split('/').slice(0, -1).join('/');
            return { [conflict.path]: conflict.mine, [`${dir}/${name}${FLOW_EXT}`]: conflict.theirs };
        }
        case 'rename-rename':
            return pick?.path
                ? {
                      [pick.path === 'mine' ? conflict.mine : conflict.theirs]: conflict.content,
                      [pick.path === 'mine' ? conflict.theirs : conflict.mine]: null,
                  }
                : null;
    }
}

export function ConflictDialog({
    conflicts,
    title,
    description,
    onCancel,
    onSubmit,
}: {
    conflicts: TreeConflict[] | null;
    title: string;
    description: string;
    onCancel: () => void;
    onSubmit: (resolution: Overlay) => string | null;
}) {
    const [picks, setPicks] = useState<Record<string, Pick>>({});
    const [error, setError] = useState('');
    const resolutions = (conflicts ?? []).map(c => resolutionOf(c, picks[c.key]));
    const done = resolutions.every(Boolean);
    const set = (key: string, patch: Pick) => setPicks({ ...picks, [key]: { ...picks[key], ...patch } });
    return (
        <Dialog
            open={!!conflicts}
            onOpenChange={o => {
                if (!o) {
                    setPicks({});
                    setError('');
                    onCancel();
                }
            }}
        >
            <DialogContent className="sm:max-w-5xl">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <div className="grid max-h-[65vh] gap-5 overflow-auto pr-1">
                    {conflicts?.map(c => (
                        <div key={c.key} className="grid gap-2 rounded-lg border p-3">
                            <ConflictBody conflict={c} pick={picks[c.key]} onPick={patch => set(c.key, patch)} />
                        </div>
                    ))}
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => {
                            setPicks({});
                            setError('');
                            onCancel();
                        }}
                    >
                        Cancel
                    </Button>
                    <Button
                        disabled={!done}
                        onClick={() => {
                            const problem = onSubmit(Object.assign({}, ...resolutions) as Overlay);
                            if (problem) {
                                setError(problem);
                            } else {
                                setPicks({});
                                setError('');
                            }
                        }}
                    >
                        Use this result
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function ConflictBody({ conflict, pick, onPick }: { conflict: TreeConflict; pick: Pick | undefined; onPick: (patch: Pick) => void }) {
    if (conflict.kind === 'modify-delete') {
        return (
            <>
                <span className="font-mono text-xs">{rel(conflict.path)}</span>
                <p className="text-sm">
                    {conflict.deleted === 'mine'
                        ? 'You deleted it; the other side edited it.'
                        : 'You edited it; the other side deleted it.'}
                </p>
                <div className="flex gap-4 text-sm">
                    <Radio checked={pick?.keep === true} onChange={() => onPick({ keep: true })} label="Keep it, with the edit" />
                    <Radio checked={pick?.keep === false} onChange={() => onPick({ keep: false })} label="Delete it" />
                </div>
            </>
        );
    }
    if (conflict.kind === 'add-add') {
        const name = conflict.path.split('/').pop()!.slice(0, -FLOW_EXT.length);
        return (
            <>
                <span className="font-mono text-xs">{rel(conflict.path)}</span>
                <p className="text-sm">Both sides added a flow named "{name}", with different ids: they are two flows. Rename theirs.</p>
                <Input
                    className="max-w-sm"
                    placeholder={`${name} (2)`}
                    value={pick?.rename ?? ''}
                    onChange={e => onPick({ rename: e.target.value })}
                />
            </>
        );
    }
    if (conflict.kind === 'rename-rename') {
        return (
            <>
                <span className="font-mono text-xs">{rel(conflict.base)}</span>
                <p className="text-sm">Both sides renamed this flow. Keep one name:</p>
                <div className="grid gap-1 text-sm">
                    <Radio
                        checked={pick?.path === 'mine'}
                        onChange={() => onPick({ path: 'mine' })}
                        label={`Mine: ${rel(conflict.mine)}`}
                    />
                    <Radio
                        checked={pick?.path === 'theirs'}
                        onChange={() => onPick({ path: 'theirs' })}
                        label={`Theirs: ${rel(conflict.theirs)}`}
                    />
                </div>
            </>
        );
    }
    const indexes = conflict.segments.map((_, i) => conflict.segments.slice(0, i).filter(x => x.kind === 'conflict').length);
    const hunks = pick?.hunks ?? [];
    return (
        <>
            <span className="font-mono text-xs">{rel(conflict.path)}</span>
            <p className="text-xs text-muted-foreground">What did not conflict is already merged. Choose each conflicting hunk.</p>
            <div className="grid gap-1 font-mono text-xs">
                {conflict.segments.map((segment, i) => {
                    if (segment.kind === 'ok') {
                        return (
                            <pre key={i} className="overflow-auto px-2 leading-5 text-muted-foreground">
                                {segment.lines.length > 6
                                    ? [
                                          ...segment.lines.slice(0, 2),
                                          `… ${segment.lines.length - 4} lines …`,
                                          ...segment.lines.slice(-2),
                                      ].join('\n')
                                    : segment.lines.join('\n')}
                            </pre>
                        );
                    }
                    const index = indexes[i]!;
                    const choice = hunks[index];
                    const choose = (value: HunkChoice) => {
                        const next = [...hunks];
                        next[index] = value;
                        onPick({ hunks: next });
                    };
                    return (
                        <div key={i} className="grid gap-1 rounded-md border border-amber-500/50 p-2">
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <p className="font-sans text-[11px] text-muted-foreground">Mine</p>
                                    <pre className="overflow-auto rounded bg-emerald-500/10 px-2 leading-5">
                                        {segment.mine.join('\n') || '(nothing)'}
                                    </pre>
                                </div>
                                <div>
                                    <p className="font-sans text-[11px] text-muted-foreground">Theirs</p>
                                    <pre className="overflow-auto rounded bg-sky-500/10 px-2 leading-5">
                                        {segment.theirs.join('\n') || '(nothing)'}
                                    </pre>
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-3 font-sans text-sm">
                                <Radio checked={choice === 'mine'} onChange={() => choose('mine')} label="Mine" />
                                <Radio checked={choice === 'theirs'} onChange={() => choose('theirs')} label="Theirs" />
                                <Radio checked={choice === 'both'} onChange={() => choose('both')} label="Both" />
                                <Radio
                                    checked={typeof choice === 'object'}
                                    onChange={() => choose({ text: segment.mine.join('\n') })}
                                    label="Edit"
                                />
                            </div>
                            {typeof choice === 'object' && (
                                <Textarea
                                    className="font-mono text-xs"
                                    rows={Math.max(2, segment.mine.length)}
                                    value={choice.text}
                                    onChange={e => choose({ text: e.target.value })}
                                />
                            )}
                        </div>
                    );
                })}
            </div>
        </>
    );
}

const Radio = ({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) => (
    <label className={cn('flex items-center gap-1.5', checked && 'font-semibold')}>
        <input type="radio" checked={checked} onChange={onChange} />
        {label}
    </label>
);
