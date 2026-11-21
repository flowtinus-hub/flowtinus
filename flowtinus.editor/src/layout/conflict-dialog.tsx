import { useEffect, useState } from 'react';
import { Copy, LoaderCircle, TriangleAlert, Undo2 } from 'lucide-react';
import { ConfirmDialog, type ConfirmTarget } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { discardDraft } from '@/data/deployments/deployments-api';
import { CHANGES_CHANGED, discardChanges, getConflict, resolveConflict, type ConflictResolution, type ConflictSegment, type ConflictView, type HunkChoice } from '@/data/git/git-api';
import type { ApiError, ApiResult } from '@/lib/api';
import { cn } from '@/lib/utils';

const shortPath = (slug: string, path: string) => (path.startsWith(`${slug}/`) ? path.slice(slug.length + 1) : path);

const hunkCount = (segments: ConflictSegment[]) => segments.filter(s => 'hunk' in s).length;

function resolutionOf(view: ConflictView, pick: ConflictResolution): ConflictResolution | null {
    const conflict = view.conflict;
    switch (conflict.type) {
        case 'content': {
            const hunks = pick.hunks ?? [];
            const all = hunks.filter(Boolean).length === hunkCount(conflict.segments);
            return all && (!conflict.names || pick.name) ? { hunks, ...(conflict.names ? { name: pick.name } : {}) } : null;
        }
        case 'deleted':
            return pick.keep === undefined ? null : { keep: pick.keep };
        case 'added':
            return pick.rename?.trim() ? { rename: pick.rename.trim() } : null;
    }
}

const Radio = ({ checked, onChange, label, disabled }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) => (
    <label className={cn('flex items-center gap-1.5', checked && 'font-semibold')}>
        <input type="radio" checked={checked} disabled={disabled} onChange={onChange} />
        {label}
    </label>
);

export function ConflictDialog({
    slug,
    path,
    onClose,
    onResolved,
}: {
    slug: string;
    path: string;
    onClose: () => void;
    onResolved: () => void;
}) {
    const [view, setView] = useState<ConflictView | null>(null);
    const [pick, setPick] = useState<ConflictResolution>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);

    useEffect(() => {
        let gone = false;
        void getConflict(slug, path).then(result => {
            if (gone) {
                return;
            }
            if (result.ok) {
                setView(result.value);
            } else {
                setError(result.error);
            }
        });
        return () => {
            gone = true;
        };
    }, [slug, path]);

    const resolution = view ? resolutionOf(view, pick) : null;
    const act = async (action: () => Promise<ApiResult<unknown>>) => {
        setBusy(true);
        setError(null);
        const result = await action();
        setBusy(false);
        if (result.ok) {
            window.dispatchEvent(new Event(CHANGES_CHANGED));
            onResolved();
            onClose();
        } else {
            setError(result.error);
        }
    };
    const copyName = (path.split('/').pop() ?? '').replace(/\.flow\.yaml$/, '');

    return (
        <Dialog open onOpenChange={isOpen => !isOpen && !busy && onClose()}>
            <DialogContent className="sm:max-w-5xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <TriangleAlert className="size-4 text-amber-500" />
                        {shortPath(slug, path)}
                    </DialogTitle>
                    <DialogDescription>
                        {view ? (
                            <>
                                Your uncommitted change against <span className="font-mono">{view.commit.slice(0, 7)}</span>. The result
                                stays in your working copy, to commit.
                            </>
                        ) : (
                            'Reading the conflict…'
                        )}
                    </DialogDescription>
                </DialogHeader>
                {!view ? (
                    !error && <LoaderCircle className="animate-spin" />
                ) : (
                    <div className="grid max-h-[65vh] gap-3 overflow-auto pr-1">
                        <ConflictBody
                            slug={slug}
                            view={view}
                            pick={pick}
                            disabled={busy}
                            onPick={patch => setPick(p => ({ ...p, ...patch }))}
                        />
                    </div>
                )}
                {error && (
                    <div className="grid gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
                        <span>{error.message}</span>
                        {Object.entries(error.fields ?? {}).map(([file, errors]) => (
                            <span key={file} className="grid">
                                <span className="font-mono text-xs">{shortPath(slug, file)}</span>
                                <span className="text-xs whitespace-pre-line">{errors}</span>
                            </span>
                        ))}
                    </div>
                )}
                <DialogFooter className="sm:justify-between">
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            disabled={busy || !view}
                            title="Your change goes; the file takes what git has"
                            onClick={() =>
                                setConfirm({
                                    title: `Discard the changes of ${shortPath(slug, path)}?`,
                                    description: "The file takes git's content; your change is lost.",
                                    confirmLabel: 'Discard mine',
                                    busyLabel: 'Discarding…',
                                    destructive: true,
                                    onConfirm: async () => {
                                        const result = await discardChanges(slug, { paths: [path] });
                                        if (result.ok) {
                                            window.dispatchEvent(new Event(CHANGES_CHANGED));
                                            onResolved();
                                            onClose();
                                        }
                                        return result;
                                    },
                                })
                            }
                        >
                            <Undo2 /> Discard mine
                        </Button>
                        {view?.duplicable && view.fileId && (
                            <Button
                                variant="outline"
                                disabled={busy}
                                title={`A new flow, a draft only, keeps your draft as "${copyName} (my draft)"; this one takes git's`}
                                onClick={() => void act(() => discardDraft(view.fileId!, `${copyName} (my draft)`))}
                            >
                                <Copy /> Duplicate as a new flow
                            </Button>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <Button variant="outline" disabled={busy} onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            disabled={busy || !view || !resolution}
                            onClick={() => void act(() => resolveConflict(slug, path, view!.revision, resolution!))}
                        >
                            {busy && <LoaderCircle className="animate-spin" />}
                            Use this result
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
            <ConfirmDialog target={confirm} onClose={() => setConfirm(null)} />
        </Dialog>
    );
}

function ConflictBody({
    slug,
    view,
    pick,
    disabled,
    onPick,
}: {
    slug: string;
    view: ConflictView;
    pick: ConflictResolution;
    disabled: boolean;
    onPick: (patch: ConflictResolution) => void;
}) {
    const conflict = view.conflict;
    if (conflict.type === 'deleted') {
        return (
            <>
                <p className="text-sm">
                    {conflict.deletedBy === 'mine' ? 'You deleted it; the branch edited it.' : 'You edited it; the branch deleted it.'}
                </p>
                <pre className="max-h-64 overflow-auto rounded bg-muted/50 px-2 py-1 font-mono text-xs leading-5">{conflict.text}</pre>
                <div className="flex gap-4 text-sm">
                    <Radio
                        disabled={disabled}
                        checked={pick.keep === true}
                        onChange={() => onPick({ keep: true })}
                        label="Keep it, with the edit"
                    />
                    <Radio disabled={disabled} checked={pick.keep === false} onChange={() => onPick({ keep: false })} label="Delete it" />
                </div>
            </>
        );
    }
    if (conflict.type === 'added') {
        return (
            <>
                <p className="text-sm">
                    You and the branch each added &quot;{conflict.name}&quot;, with different ids: they are two. Give yours another name.
                </p>
                <div className="grid grid-cols-2 gap-2 font-mono text-xs">
                    <div>
                        <p className="font-sans text-[11px] text-muted-foreground">Yours</p>
                        <pre className="max-h-48 overflow-auto rounded bg-emerald-500/10 px-2 leading-5">{conflict.mine}</pre>
                    </div>
                    <div>
                        <p className="font-sans text-[11px] text-muted-foreground">The branch&apos;s</p>
                        <pre className="max-h-48 overflow-auto rounded bg-sky-500/10 px-2 leading-5">{conflict.theirs}</pre>
                    </div>
                </div>
                <Input
                    className="max-w-sm"
                    aria-label="New name for yours"
                    placeholder={`${conflict.name} 2`}
                    disabled={disabled}
                    value={pick.rename ?? ''}
                    onChange={e => onPick({ rename: e.target.value })}
                />
            </>
        );
    }

    const hunks = pick.hunks ?? [];
    const indexes = conflict.segments.map((_, i) => conflict.segments.slice(0, i).filter(x => 'hunk' in x).length);
    return (
        <>
            {conflict.names && (
                <div className="grid gap-1 text-sm">
                    <p>Both renamed this flow. Keep one name:</p>
                    <Radio
                        disabled={disabled}
                        checked={pick.name === 'mine'}
                        onChange={() => onPick({ name: 'mine' })}
                        label={`Yours: ${shortPath(slug, conflict.names.mine)}`}
                    />
                    <Radio
                        disabled={disabled}
                        checked={pick.name === 'theirs'}
                        onChange={() => onPick({ name: 'theirs' })}
                        label={`The branch's: ${shortPath(slug, conflict.names.theirs)}`}
                    />
                </div>
            )}
            <p className="text-xs text-muted-foreground">
                {hunkCount(conflict.segments) > 0
                    ? 'What did not conflict is already merged. Choose each conflicting hunk.'
                    : 'The content merged cleanly.'}
            </p>
            <div className="grid gap-1 font-mono text-xs">
                {conflict.segments.map((segment, i) => {
                    if ('lines' in segment) {
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
                                        {segment.hunk.mine.join('\n') || '(nothing)'}
                                    </pre>
                                </div>
                                <div>
                                    <p className="font-sans text-[11px] text-muted-foreground">Theirs</p>
                                    <pre className="overflow-auto rounded bg-sky-500/10 px-2 leading-5">
                                        {segment.hunk.theirs.join('\n') || '(nothing)'}
                                    </pre>
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-3 font-sans text-sm">
                                <Radio disabled={disabled} checked={choice === 'mine'} onChange={() => choose('mine')} label="Mine" />
                                <Radio disabled={disabled} checked={choice === 'theirs'} onChange={() => choose('theirs')} label="Theirs" />
                                <Radio disabled={disabled} checked={choice === 'both'} onChange={() => choose('both')} label="Both" />
                                <Radio
                                    disabled={disabled}
                                    checked={typeof choice === 'object'}
                                    onChange={() => choose({ edit: segment.hunk.mine.join('\n') })}
                                    label="Edit"
                                />
                            </div>
                            {typeof choice === 'object' && (
                                <Textarea
                                    aria-label={`Hunk ${index + 1}`}
                                    className="font-mono text-xs"
                                    rows={Math.max(2, segment.hunk.mine.length)}
                                    disabled={disabled}
                                    value={choice.edit}
                                    onChange={e => choose({ edit: e.target.value })}
                                />
                            )}
                        </div>
                    );
                })}
            </div>
        </>
    );
}
