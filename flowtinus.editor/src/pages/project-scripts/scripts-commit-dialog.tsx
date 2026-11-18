import { useState } from 'react';
import { CircleCheck, GitCommitHorizontal, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { commitScripts, type ScriptEntry } from '@/data/scripts/scripts-store';
import type { ApiResult } from '@/lib/api';

/** with git on: the scripts changed since they were committed, checked, go to the branch in one commit */
export function ScriptsCommitDialog({ projectId, scripts, onClose }: { projectId: string; scripts: ScriptEntry[]; onClose: () => void }) {
    const changed = scripts.filter(s => s.changed);
    const [checked, setChecked] = useState(() => new Set(changed.filter(s => !s.conflict).map(s => s.path)));
    const [message, setMessage] = useState(() => `Update ${changed.map(s => s.path).join(', ')}`);
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<ApiResult<{ commit: string }> | null>(null);
    const commit = async () => {
        setBusy(true);
        setOutcome(await commitScripts(projectId, [...checked], message.trim()));
        setBusy(false);
    };
    const toggle = (path: string, on: boolean) =>
        setChecked(current => {
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
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Commit scripts</DialogTitle>
                    <DialogDescription>
                        The scripts as they are being edited go to the branch; deployed runs take them once the commit applies.
                    </DialogDescription>
                </DialogHeader>
                {outcome?.ok ? (
                    <p className="flex items-center gap-2 text-sm">
                        <CircleCheck className="size-4 text-emerald-600" />
                        <span>
                            <span className="font-mono">{outcome.value.commit.slice(0, 7)}</span> applied
                        </span>
                    </p>
                ) : (
                    <>
                        <fieldset className="grid gap-1 text-sm">
                            {changed.map(script => (
                                <label key={script.path} className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={checked.has(script.path)}
                                        disabled={busy || !!script.conflict}
                                        onChange={e => toggle(script.path, e.target.checked)}
                                    />
                                    <span className="font-mono text-xs">{script.path}.ts</span>
                                    {script.conflict && (
                                        <span className="text-xs text-red-700 dark:text-red-400">
                                            conflicts with {script.conflict.slice(0, 7)}: discard its changes first
                                        </span>
                                    )}
                                </label>
                            ))}
                        </fieldset>
                        <Input
                            aria-label="Commit message"
                            value={message}
                            disabled={busy}
                            onChange={e => setMessage(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && message.trim() && checked.size > 0 && !busy && void commit()}
                        />
                        {outcome && !outcome.ok && (
                            <div className="grid gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
                                <span>{outcome.error.message}</span>
                                {Object.entries(outcome.error.fields ?? {}).map(([file, errors]) => (
                                    <span key={file} className="grid">
                                        <span className="font-mono text-xs">{file}</span>
                                        <span className="text-xs whitespace-pre-line">{errors}</span>
                                    </span>
                                ))}
                            </div>
                        )}
                    </>
                )}
                <DialogFooter>
                    {outcome?.ok ? (
                        <Button onClick={onClose}>Close</Button>
                    ) : (
                        <>
                            <Button variant="outline" disabled={busy} onClick={onClose}>
                                Cancel
                            </Button>
                            <Button disabled={busy || checked.size === 0 || !message.trim()} onClick={() => void commit()}>
                                {busy ? <LoaderCircle className="animate-spin" /> : <GitCommitHorizontal />}
                                {busy ? 'Committing…' : `Commit ${checked.size}`}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
