import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { projectsPath } from '@/app/paths';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createBranch } from '@/data/git/git-api';
import type { ApiError } from '@/lib/api';

/**
 * Create branch: cut from the current branch's tip, named users/<handle>/… (the prefix fixed, the user types the rest), pushed at once. The user's
 * uncommitted changes go along to it, and the editor opens on it.
 */
export function CreateBranchDialog({ slug, from, handle, onClose }: { slug: string; from: string; handle: string; onClose: () => void }) {
    const prefix = `users/${handle}/`;
    // the prefix is fixed: the field holds the rest of the name
    const [rest, setRest] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const own = from.startsWith(prefix);

    const create = async () => {
        setBusy(true);
        setError(null);
        const result = await createBranch(slug, `${prefix}${rest.trim()}`);
        if (!result.ok) {
            setBusy(false);
            setError(result.error);
            return;
        }
        // every page read so far was the other branch's
        window.location.assign(projectsPath(slug));
    };

    const fieldError = error?.fields?.name;
    return (
        <Dialog open onOpenChange={open => !open && !busy && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Create branch</DialogTitle>
                    <DialogDescription>
                        From the tip of <span className="font-mono">{from}</span>, pushed at once.{' '}
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
