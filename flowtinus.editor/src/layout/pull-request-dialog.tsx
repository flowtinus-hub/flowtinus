import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, GitPullRequestArrow, LoaderCircle } from 'lucide-react';
import { WarningLine } from '@/components/warning-line';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getGitConfig, GIT_STATUS_CHANGED, openPullRequest, PROVIDERS, pullRequestName, pullRequestNamed, type Provider, type PullRequest } from '@/data/git/git-api';
import { plural } from '@/lib/plural';

function titleFrom(branch: string): string {
    const words = (branch.split('/').at(-1) ?? branch).replace(/[-_]+/g, ' ').trim();
    return words ? words[0]!.toUpperCase() + words.slice(1) : branch;
}

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
    const [adapter, setAdapter] = useState<Provider | false | null>(null);
    const [title, setTitle] = useState(() => titleFrom(branch));
    const [opening, setOpening] = useState(false);
    const [result, setResult] = useState<{ value?: PullRequest; error?: string } | null>(null);
    const gone = useRef(false);

    const open = useCallback(
        async (withTitle?: string) => {
            setOpening(true);
            const answer = await openPullRequest(handle, withTitle);
            if (answer.ok && answer.value.pushed) {
                window.dispatchEvent(new Event(GIT_STATUS_CHANGED));
            }
            if (!gone.current) {
                setOpening(false);
                setResult(answer.ok ? { value: answer.value } : { error: answer.error.message });
            }
        },
        [handle],
    );

    useEffect(() => {
        gone.current = false;
        // per run, not the shared ref: a run cleaned up and run again (StrictMode) would otherwise open it twice
        let cancelled = false;
        void getGitConfig(handle).then(answer => {
            if (cancelled) {
                return;
            }
            const on = answer.ok && answer.value.adapter?.on ? answer.value.adapter.provider : false;
            setAdapter(on);
            if (!on) {
                void open();
            }
        });
        return () => {
            cancelled = true;
            gone.current = true;
        };
    }, [handle, open]);

    const pr = result?.value;
    const asking = adapter && !result ? adapter : null;
    return (
        <Dialog open onOpenChange={next => !next && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Open a pull request</DialogTitle>
                    <DialogDescription>
                        From <span className="font-mono">{branch}</span> into <span className="font-mono">{target}</span>, the environment
                        of this server.
                    </DialogDescription>
                </DialogHeader>
                {asking && (
                    <form
                        id="pull-request-title"
                        className="grid gap-2"
                        onSubmit={event => {
                            event.preventDefault();
                            void open(title.trim());
                        }}
                    >
                        <Label htmlFor="pull-request-title-input">Title</Label>
                        <Input
                            id="pull-request-title-input"
                            value={title}
                            maxLength={255}
                            autoFocus
                            disabled={opening}
                            onChange={event => setTitle(event.target.value)}
                        />
                    </form>
                )}
                {(adapter === null || (adapter === false && !result) || opening) && (
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
                        {pr.mergeRequest && pr.provider && (
                            <p className="first-letter:uppercase">{pullRequestNamed(pr.provider, pr.mergeRequest.number)} is open.</p>
                        )}
                        {pr.notice && <p className="text-xs text-amber-700 dark:text-amber-400">{pr.notice}</p>}
                        {pr.endsEmergencyRollback && <WarningLine>{pr.endsEmergencyRollback}</WarningLine>}
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
                    </div>
                )}
                {uncommitted > 0 && (pr || asking) && (
                    <p className="text-xs text-muted-foreground">
                        {plural(uncommitted, 'uncommitted change')} on this branch {uncommitted === 1 ? 'does' : 'do'} not go in the pull
                        request: commit {uncommitted === 1 ? 'it' : 'them'} first.
                    </p>
                )}
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onClose}>
                        Close
                    </Button>
                    {asking && (
                        <Button type="submit" form="pull-request-title" disabled={opening || !title.trim()}>
                            <GitPullRequestArrow />
                            Open the {pullRequestName(asking)}
                        </Button>
                    )}
                    {pr?.url && (
                        <Button asChild>
                            <a href={pr.url} target="_blank" rel="noreferrer" onClick={onClose}>
                                <ExternalLink />
                                {pr.mergeRequest ? 'Open it' : 'Open'} on {pr.provider ? PROVIDERS[pr.provider] : 'the provider'}
                            </a>
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
