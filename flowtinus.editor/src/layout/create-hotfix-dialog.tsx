import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { branchNamePart, createHotfix } from '@/data/git/git-api';
import type { ApiError } from '@/lib/api';
import { landAfterSwitch } from './branch-landing';

export function CreateHotfixDialog({ handle, environment, onClose }: { handle: string; environment: string; onClose: () => void }) {
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ApiError | null>(null);
    const branchName = branchNamePart(name);

    const create = async () => {
        setBusy(true);
        setError(null);
        const result = await createHotfix(handle, branchName);
        if (!result.ok) {
            setBusy(false);
            setError(result.error);
            return;
        }
        await landAfterSwitch(handle);
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
                            hotfix/
                        </span>
                        <Input
                            id="hotfix-name"
                            className="rounded-l-none font-mono"
                            aria-describedby="hotfix-prefix"
                            value={name}
                            autoFocus
                            disabled={busy}
                            aria-invalid={!!fieldError}
                            onChange={event => setName(event.target.value)}
                        />
                    </div>
                    {branchName !== '' && branchName !== name.trim() && (
                        <p className="text-xs text-muted-foreground">
                            The branch will be <span className="font-mono">hotfix/{branchName}</span>.
                        </p>
                    )}
                    {(fieldError ?? error?.message) && <p className="text-xs text-destructive">{fieldError ?? error?.message}</p>}
                    <DialogFooter>
                        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy || branchName === ''}>
                            {busy && <LoaderCircle className="animate-spin" />}
                            Create hotfix
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
