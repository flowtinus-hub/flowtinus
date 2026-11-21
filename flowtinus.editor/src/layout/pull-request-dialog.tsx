import { useEffect, useState } from 'react';
import { ExternalLink, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { GIT_STATUS_CHANGED, openPullRequest, type PullRequest } from '@/data/git/git-api';

const PROVIDERS = { gitlab: 'GitLab', github: 'GitHub' };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function PullRequestDialog({
    handle,
    branch,
    target,
    uncommitted,
    onClose,
}: {
    handle: string;
    branch: string;
    target: string;
    uncommitted: number;
    onClose: () => void;
}) {
    const [result, setResult] = useState<{ value?: PullRequest; error?: string } | null>(null);

    useEffect(() => {
        let gone = false;
        void openPullRequest(handle).then(answer => {
            if (answer.ok && answer.value.pushed) {
                window.dispatchEvent(new Event(GIT_STATUS_CHANGED));
            }
            if (!gone) {
                setResult(answer.ok ? { value: answer.value } : { error: answer.error.message });
            }
        });
        return () => {
            gone = true;
        };
    }, [handle]);

    const pr = result?.value;
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Open a pull request</DialogTitle>
                    <DialogDescription>
                        From <span className="font-mono">{branch}</span> into <span className="font-mono">{target}</span>, the environment
                        of this server.
                    </DialogDescription>
                </DialogHeader>
                {!result && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <LoaderCircle className="size-4 animate-spin" /> Checking the branch on the remote...
                    </p>
                )}
                {result?.error && <p className="text-sm text-destructive">{result.error}</p>}
                {pr && (
                    <div className="grid gap-2 text-sm">
                        <p>
                            {plural(pr.commits, 'commit')} of <span className="font-mono">{pr.branch}</span>{' '}
                            {pr.commits === 1 ? 'is' : 'are'} not in <span className="font-mono">{pr.target}</span> yet.
                        </p>
                        {pr.pushed && (
                            <p className="text-muted-foreground">
                                The remote did not have the last commit of <span className="font-mono">{pr.branch}</span>: it is pushed now.
                            </p>
                        )}
                        {pr.borrowed.map(b => (
                            <p key={b.branch} className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
                                It includes {plural(b.commits, 'commit')} from <span className="font-mono">{b.branch}</span>, not yet in{' '}
                                {pr.target}: they leave the diff once that branch is merged.
                            </p>
                        ))}
                        {!pr.url && (
                            <p className="text-muted-foreground">
                                The branch is pushed. Open a pull request from <span className="font-mono">{pr.branch}</span> into{' '}
                                <span className="font-mono">{pr.target}</span> on your git provider.
                            </p>
                        )}
                        {uncommitted > 0 && (
                            <p className="text-xs text-muted-foreground">
                                {plural(uncommitted, 'uncommitted change')} on this branch {uncommitted === 1 ? 'does' : 'do'} not go in the
                                pull request: commit {uncommitted === 1 ? 'it' : 'them'} first.
                            </p>
                        )}
                    </div>
                )}
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose}>
                        Close
                    </Button>
                    {pr?.url && (
                        <Button asChild>
                            <a href={pr.url} target="_blank" rel="noreferrer" onClick={onClose}>
                                <ExternalLink />
                                Open on {pr.provider ? PROVIDERS[pr.provider] : 'the provider'}
                            </a>
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
