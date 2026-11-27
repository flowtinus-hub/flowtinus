import { GitBranch, GitCommitHorizontal } from 'lucide-react';
import { useGitStatus } from '@/data/git/git-status';

export function LocalHeadMark({ handle }: { handle: string }) {
    const status = useGitStatus(handle);
    const value = status && !status.on ? status.disk?.head : undefined;
    if (!value) {
        return null;
    }
    const name = value.branch ?? value.sha ?? '';
    return (
        <span
            className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground"
            title={`${value.branch ? `The branch ${name}` : `HEAD detached at ${name}`} is checked out in your clone: git is yours (commit, push and switch branches with it).`}
        >
            {value.branch ? <GitBranch className="size-4 shrink-0" /> : <GitCommitHorizontal className="size-4 shrink-0" />}
            <span className="truncate font-mono">{name}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase">local</span>
        </span>
    );
}
