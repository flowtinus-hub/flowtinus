import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { FlowFile } from '@flowtinus/core';
import { branchNamePart, createBranch } from '@/data/git/git-api';
import type { ApiError, ApiResult } from '@/lib/api';
import { landingAfterSwitch, noteBranchSwitch } from './branch-landing';

export type OfferedEdit = {
    name: string;
    draft?: () => { flowId: string; flow: FlowFile } | null;
    replay?: () => Promise<ApiResult<unknown>>;
};

export function CreateBranchDialog({
    handle,
    from,
    lostTip,
    userHandle,
    edit,
    onClose,
}: {
    handle: string;
    from: string;
    lostTip?: boolean;
    userHandle: string;
    edit?: OfferedEdit;
    onClose: () => void;
}) {
    const prefix = `users/${userHandle}/`;
    const [rest, setRest] = useState(() => (edit ? branchNamePart(edit.name) : ''));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const [made, setMade] = useState<{ branch: string; error: string } | null>(null);
    const own = from.startsWith(prefix);

    // every page read so far was the other branch's: the same page again on the new one
    const open = async () => (edit ? window.location.reload() : window.location.assign(await landingAfterSwitch(handle)));

    const create = async () => {
        setBusy(true);
        setError(null);
        const name = `${prefix}${rest.trim()}`;
        const result = await createBranch(handle, name, edit?.draft?.() ?? undefined);
        if (!result.ok) {
            setBusy(false);
            setError(result.error);
            return;
        }
        noteBranchSwitch();
        const replayed = edit?.replay ? await edit.replay() : null;
        if (replayed && !replayed.ok) {
            setBusy(false);
            setMade({ branch: name, error: replayed.error.fields?.name ?? replayed.error.message });
            return;
        }
        open();
    };

    if (made) {
        return (
            <Dialog open onOpenChange={isOpen => !isOpen && open()}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Branch created</DialogTitle>
                        <DialogDescription>
                            You are on <span className="font-mono">{made.branch}</span> now, but the change was not made there:
                        </DialogDescription>
                    </DialogHeader>
                    <p className="text-sm text-destructive">{made.error}</p>
                    <DialogFooter>
                        <Button onClick={open}>Open the branch</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        );
    }

    const fieldError = error?.fields?.name;
    return (
        <Dialog open onOpenChange={isOpen => !isOpen && !busy && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Create branch</DialogTitle>
                    <DialogDescription>
                        {edit && (
                            <>
                                <span className="font-mono">{from}</span> only takes pull requests: make your change on a branch of your
                                own. Your edit goes along.{' '}
                            </>
                        )}
                        {lostTip ? (
                            <>
                                <span className="font-mono">{from}</span> was removed while git was off and its last commit is not known
                                here: the new branch starts from the tip of the environment&apos;s branch, pushed at once.{' '}
                            </>
                        ) : (
                            <>
                                From the tip of <span className="font-mono">{from}</span>, pushed at once.{' '}
                            </>
                        )}
                        {own
                            ? 'Every uncommitted change of this branch goes along.'
                            : 'Your uncommitted changes go along; the others stay here.'}
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="grid gap-2"
                    onSubmit={event => {
                        event.preventDefault();
                        void create();
                    }}
                >
                    <Label htmlFor="branch-name">Name</Label>
                    <div className="flex">
                        <span
                            id="branch-prefix"
                            className="flex items-center rounded-l-md border border-r-0 border-input bg-muted px-3 font-mono text-sm text-muted-foreground"
                        >
                            {prefix}
                        </span>
                        <Input
                            id="branch-name"
                            className="rounded-l-none font-mono"
                            aria-describedby="branch-prefix"
                            value={rest}
                            autoFocus
                            disabled={busy}
                            aria-invalid={!!fieldError}
                            onChange={event => setRest(event.target.value)}
                        />
                    </div>
                    {(fieldError ?? error?.message) && <p className="text-xs text-destructive">{fieldError ?? error?.message}</p>}
                    <DialogFooter>
                        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy || rest.trim() === ''}>
                            {busy && <LoaderCircle className="animate-spin" />}
                            Create branch
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
