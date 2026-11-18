import { useState } from 'react';
import { CircleCheck, GitCommitHorizontal, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GIT_STATUS_CHANGED, reconcileNow, type GitCommitView, type GitStatus, type ReconcileOutcome } from '@/data/git/git-api';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';

/** a commit as the git section names it: its short sha, message, author and when */
function CommitLine({ commit }: { commit: GitCommitView }) {
    return (
        <span className="min-w-0">
            <span className="font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</span> {commit.message ?? ''}
            {(commit.author || commit.at) && (
                <span className="text-muted-foreground" title={commit.at ? formatDateTime(new Date(commit.at)) : undefined}>
                    {' '}
                    · {[commit.author, commit.at ? relativeTime(new Date(commit.at)) : null].filter(Boolean).join(' · ')}
                </span>
            )}
        </span>
    );
}

function Issues({ issues, tone }: { issues: { path: string; message: string }[]; tone: 'error' | 'warn' }) {
    const byFile = new Map<string, { path: string; message: string }[]>();
    for (const issue of issues) {
        byFile.set(issue.path, [...(byFile.get(issue.path) ?? []), issue]);
    }
    return (
        <ul className={`grid gap-1 text-xs ${tone === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}`}>
            {[...byFile].map(([path, found]) => (
                <li key={path} className="grid">
                    <span className="font-mono">{path}</span>
                    {found.map(f => (
                        <span key={f.message}>{f.message}</span>
                    ))}
                </li>
            ))}
        </ul>
    );
}

const OUTCOME: Record<ReconcileOutcome, string> = {
    applied: 'Applied: the deploy is on the branch tip now.',
    'up-to-date': 'Up to date: the deploy is on the branch tip.',
    refused: 'Refused: the branch tip is not valid, the deploy stays where it was.',
};

/**
 * With git on: the commit the deploy is on, and whether git is ahead of it (a refused commit and its errors per file,
 * or git unreachable since when); the warnings of the commit applied; Reconcile now.
 */
export function GitStatusPanel({
    slug,
    status,
    readOnly,
    onChanged,
}: {
    slug: string;
    status: GitStatus;
    readOnly: boolean;
    onChanged: () => Promise<void>;
}) {
    const [busy, setBusy] = useState(false);
    const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
    if (!status.on) {
        return null;
    }

    const reconcile = async () => {
        setBusy(true);
        setSaid(null);
        const result = await reconcileNow(slug);
        await onChanged();
        window.dispatchEvent(new Event(GIT_STATUS_CHANGED));
        setBusy(false);
        setSaid(
            result.ok
                ? { ok: result.value.outcome !== 'refused', text: OUTCOME[result.value.outcome] }
                : { ok: false, text: result.error.message },
        );
    };

    return (
        <div className="grid gap-3 rounded-lg border p-4 text-sm">
            <div className="flex items-start gap-2">
                <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="text-muted-foreground">The deploy is on{status.branch ? ` ${status.branch} at` : ''}</span>
                    {status.deploy ? <CommitLine commit={status.deploy} /> : <span className="text-muted-foreground">no commit yet</span>}
                </div>
                <Button type="button" variant="outline" size="sm" disabled={busy || readOnly} onClick={() => void reconcile()}>
                    {busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />} Reconcile now
                </Button>
            </div>
            {status.refused && (
                <div className="grid gap-1.5 rounded-md border border-destructive/40 p-3">
                    <span className="flex items-center gap-1.5 font-medium text-destructive">
                        <TriangleAlert className="size-4" /> Git is ahead: its commit was refused, nothing of it applied
                    </span>
                    <CommitLine commit={status.refused} />
                    <Issues issues={status.refused.errors} tone="error" />
                </div>
            )}
            {status.unreachable && (
                <p className="flex gap-1.5 text-amber-700 dark:text-amber-400">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>
                        Git unreachable since{' '}
                        <span title={formatDateTime(new Date(status.unreachable.since))}>
                            {relativeTime(new Date(status.unreachable.since))}
                        </span>
                        : {status.unreachable.error}
                    </span>
                </p>
            )}
            {status.warnings.length > 0 && (
                <div className="grid gap-1">
                    <span className="text-muted-foreground">The commit applied has warnings:</span>
                    <Issues issues={status.warnings} tone="warn" />
                </div>
            )}
            {said && (
                <p
                    className={`flex items-center gap-1.5 ${said.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}`}
                    role="status"
                >
                    {said.ok ? <CircleCheck className="size-4" /> : <TriangleAlert className="size-4" />} {said.text}
                </p>
            )}
        </div>
    );
}
