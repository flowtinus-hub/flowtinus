import { createContext, useContext, useState } from 'react';
import { Check, GitBranch, GitPullRequestArrow, Lock, Plus, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { behind, createBranch, currentBranch, currentChanges, editRefusal, server, switchBranch } from './actions';
import { isUserBranch } from './model';
import { useStore } from './store';
import { BASE, NameDialog } from './ui';

export const ChromeContext = createContext<{ openChanges: (drawer?: boolean) => void; startUpdate: () => void }>({
    openChanges: () => {},
    startUpdate: () => {},
});

export function BranchPicker({ className, canvas }: { className?: string; canvas?: boolean }) {
    const { state, act } = useStore();
    const navigate = useNavigate();
    const { startUpdate } = useContext(ChromeContext);
    const [creating, setCreating] = useState(false);
    const [base, setBase] = useState('');
    const s = server(state);
    if (!s.gitOn) {
        return null;
    }
    const branch = currentBranch(state);
    const envBranch = s.settings.branch;
    const behindCount = behind(state).length;
    const readOnly = editRefusal(state) !== null;
    const all = Object.keys(state.branches).sort();
    const mine = all.filter(b => b.startsWith(`users/${state.session.user}/`));
    const others = all.filter(b => isUserBranch(b) && !mine.includes(b));
    const elsewhere = all.filter(b => !isUserBranch(b) && b !== envBranch);
    const openPr = state.prs.find(p => p.state === 'open' && p.from === branch);
    const from = state.branches[base] ? base : branch;
    const carried = currentChanges(state).length;

    const item = (b: string, note?: string) => {
        const cutFrom = state.branchMeta[b]?.cutFrom;
        const foreign = cutFrom && cutFrom !== envBranch;
        return (
            <DropdownMenuItem key={b} onSelect={() => act(d => switchBranch(d, b))}>
                <Check className={cn(b === branch ? 'opacity-100' : 'opacity-0')} />
                <span className="flex-1 truncate font-mono text-xs">{b}</span>
                {foreign && <span className="text-[10px] text-amber-600">from {cutFrom}</span>}
                {note && <span className="text-[10px] text-muted-foreground">{note}</span>}
            </DropdownMenuItem>
        );
    };

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        className={cn('max-w-80 font-mono', canvas && 'bg-card shadow-md', className)}
                        title={`Branch: ${branch}${readOnly ? ' (read only here)' : ''}`}
                    >
                        {readOnly ? <Lock className="text-amber-600" /> : <GitBranch />}
                        <span className="truncate">{branch}</span>
                        {behindCount > 0 && (
                            <span
                                className="rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-400"
                                title={`${behindCount} commits behind ${envBranch}`}
                            >
                                ↓{behindCount}
                            </span>
                        )}
                        {openPr && (
                            <span
                                className="rounded-full bg-sky-500/15 px-1.5 text-[10px] text-sky-700 dark:text-sky-400"
                                title={`PR !${openPr.number} open`}
                            >
                                !{openPr.number}
                            </span>
                        )}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-96">
                    <DropdownMenuLabel className="font-normal text-muted-foreground">
                        {s.env} server · its branch is <span className="font-mono">{envBranch}</span>
                    </DropdownMenuLabel>
                    {item(envBranch, s.settings.directEdits ? 'direct edits = deploy' : 'protected: PR only')}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs text-muted-foreground">Your branches</DropdownMenuLabel>
                    {mine.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">None yet.</p>}
                    {mine.map(b => item(b, currentChanges(state, b).length ? `${currentChanges(state, b).length} uncommitted` : undefined))}
                    {others.length > 0 && (
                        <>
                            <DropdownMenuLabel className="text-xs text-muted-foreground">Others' branches (read only)</DropdownMenuLabel>
                            {others.map(b => item(b))}
                        </>
                    )}
                    {elsewhere.length > 0 && (
                        <>
                            <DropdownMenuLabel className="text-xs text-muted-foreground">
                                Other environments and promotions (read only)
                            </DropdownMenuLabel>
                            {elsewhere.map(b => item(b))}
                        </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        onSelect={() => {
                            setBase(branch);
                            setCreating(true);
                        }}
                    >
                        <Plus /> New branch…
                    </DropdownMenuItem>
                    {isUserBranch(branch) && !readOnly && (
                        <DropdownMenuItem disabled={behindCount === 0} onSelect={startUpdate}>
                            <RefreshCw /> Update from {envBranch}
                            <span className="ml-auto text-xs text-muted-foreground">
                                {behindCount ? `${behindCount} behind` : 'up to date'}
                            </span>
                        </DropdownMenuItem>
                    )}
                    {openPr && (
                        <DropdownMenuItem onSelect={() => navigate(`${BASE}/provider/${openPr.number}`)}>
                            <GitPullRequestArrow /> PR !{openPr.number} to {openPr.to} (provider)
                        </DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <NameDialog
                open={creating}
                title="New branch"
                description={
                    carried
                        ? `Only you write on it. Your ${carried} uncommitted change(s) on ${branch} come along, as in git.`
                        : 'Only you write on it.'
                }
                label="Name"
                prefix={`users/${state.session.user}/`}
                confirm="Create and switch"
                onClose={() => setCreating(false)}
                onSubmit={name => act(d => createBranch(d, name, from))}
            >
                <div className="grid gap-2">
                    <Label htmlFor="proto-branch-base">From</Label>
                    <select
                        id="proto-branch-base"
                        className="h-9 rounded-md border bg-background px-2 font-mono text-sm"
                        value={from}
                        onChange={e => setBase(e.target.value)}
                    >
                        {all.map(b => (
                            <option key={b} value={b}>
                                {b} @ {state.branches[b]}
                                {b === envBranch ? ` (${s.env})` : ''}
                            </option>
                        ))}
                    </select>
                </div>
            </NameDialog>
        </>
    );
}
