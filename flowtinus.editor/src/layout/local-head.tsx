import { GitBranch, GitCommitHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getGitStatus, type LocalHead } from '@/data/git/git-api';

const HEAD_MS = 5_000;

/** on a local server, in place of the branch picker: what git has checked out on the clone, read-only */
export function LocalHeadMark({ handle }: { handle: string }) {
    const [head, setHead] = useState<{ handle: string; value: LocalHead } | null>(null);
    useEffect(() => {
        let gone = false;
        const read = () =>
            void getGitStatus(handle).then(result => {
                const value = result.ok && !result.value.on ? result.value.disk?.head : undefined;
                if (!gone && value) {
                    setHead({ handle, value });
                }
            });
        read();
        const timer = setInterval(read, HEAD_MS);
        return () => {
            gone = true;
            clearInterval(timer);
        };
    }, [handle]);

    const value = head?.handle === handle ? head.value : null;
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
