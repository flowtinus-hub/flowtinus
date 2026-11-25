import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createHotfix, HOTFIX_PREFIX } from '@/data/git/git-api';
import type { ApiError } from '@/lib/api';
import { landingAfterSwitch, noteBranchSwitch } from './branch-landing';

export function CreateHotfixDialog({ handle, environment, onClose }: { handle: string; environment: string; onClose: () => void }) {
    const [rest, setRest] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);

    const create = async () => {
        setBusy(true);
        setError(null);
        const result = await createHotfix(handle, rest.trim());
        if (!result.ok) {
            setBusy(false);
            setError(result.error);
            return;
        }
        noteBranchSwitch();
        window.location.assign(await landingAfterSwitch(handle));
    };

    const fieldError = error?.fields?.name;
    return (
        <Dialog open onOpenChange={isOpen => !isOpen && !busy && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Create hotfix</DialogTitle>
                    <DialogDescription>
                        From the tip of <span className="font-mono">{environment}</span>, pushed at once. Every editor of this server works
                        on it, and its pull request goes into <span className="font-mono">{environment}</span>.
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="grid gap-2"
                    onSubmit={event => {
                        event.preventDefault();
                        void create();
                    }}
                >
                    <Label htmlFor="hotfix-name">Name</Label>
                    <div className="flex">
                        <span
                            id="hotfix-prefix"
                            className="flex items-center rounded-l-md border border-r-0 border-input bg-muted px-3 font-mono text-sm text-muted-foreground"
                        >
                            {HOTFIX_PREFIX}
                        </span>
                        <Input
                            id="hotfix-name"
                            className="rounded-l-none font-mono"
                            aria-describedby="hotfix-prefix"
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
                            Create hotfix
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
