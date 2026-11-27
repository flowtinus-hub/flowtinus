import { GitCommitHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { CHANGES_CHANGED, getChanges } from '@/data/git/git-api';
import { useUnsavedWork } from '@/data/git/unsaved-work';
import { useMe, useMenuWorkspace } from '@/data/workspaces/use-workspace';
import { API_WRITE_DONE } from '@/lib/api';
import { useServerKind } from '@/lib/server-connection';
import { BranchPicker } from './branch-picker';
import { ChangesDialog } from './changes-dialog';
import { LocalHeadMark } from './local-head';

/** looked at again on this interval, and on each page */
const CHANGES_MS = 60_000;

function ChangesButton({ handle, pathname }: { handle: string; pathname: string }) {
    const [count, setCount] = useState<{ handle: string; value: number; merging: boolean } | null>(null);
    const [open, setOpen] = useState(false);
    const unsaved = useUnsavedWork();
    useEffect(() => {
        let gone = false;
        const read = () =>
            void getChanges(handle).then(
                result =>
                    !gone &&
                    setCount({ handle, value: result.ok ? result.value.changes.length : 0, merging: result.ok && !!result.value.merge }),
            );
        read();
        const timer = setInterval(read, CHANGES_MS);
        window.addEventListener(CHANGES_CHANGED, read);
        window.addEventListener(API_WRITE_DONE, read);
        return () => {
            gone = true;
            clearInterval(timer);
            window.removeEventListener(CHANGES_CHANGED, read);
            window.removeEventListener(API_WRITE_DONE, read);
        };
    }, [handle, pathname]);

    const value = count?.handle === handle ? count.value : 0;
    const merging = count?.handle === handle && count.merging;
    if (value === 0 && !merging && !open) {
        return null;
    }
    const label = `Changes (${value})${merging ? ', merging' : ''}`;
    return (
        <>
            <Button
                variant="ghost"
                size="sm"
                title={unsaved ? `${label}. ${unsaved} to commit` : label}
                aria-label={label}
                disabled={!!unsaved}
                className="disabled:pointer-events-auto disabled:cursor-not-allowed"
                onClick={() => setOpen(true)}
            >
                <GitCommitHorizontal />
                <span>({value})</span>
                {merging && <span className="text-xs text-muted-foreground">merging</span>}
            </Button>
            {open && <ChangesDialog handle={handle} onClose={() => setOpen(false)} />}
        </>
    );
}

/** in the top bar, with git on: the current branch (a click: the branch menu) and the uncommitted changes (a click: commit them) */
export function SourceControlBar() {
    const { pathname } = useLocation();
    const { state } = useMe();
    const current = useMenuWorkspace(state.status === 'ready' ? state.me.workspaces : []);
    const kind = useServerKind();
    if (!current || kind === 'unknown') {
        return null;
    }
    if (kind === 'local') {
        return <LocalHeadMark handle={current.handle} />;
    }
    return (
        <div className="flex min-w-0 items-center gap-1">
            <BranchPicker handle={current.handle} />
            <ChangesButton handle={current.handle} pathname={pathname} />
        </div>
    );
}
