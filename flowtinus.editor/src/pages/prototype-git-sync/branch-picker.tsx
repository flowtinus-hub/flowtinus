import { createContext, useContext, useState } from 'react';
import { Check, Eye, EyeOff, Flame, GitBranch, GitPullRequestArrow, Lock, Plus, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { behind, createBranch, createHotfix, currentBranch, currentChanges, editRefusal, envBranch, server, switchBranch } from './actions';
import { backportTarget, branchKind, isAncestor, labelOf, modeOf, ownerOf } from './model';
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
    const [creating, setCreating] = useState<'branch' | 'hotfix' | null>(null);
    const [base, setBase] = useState('');
    const s = server(state);
    if (!s.gitOn) {
        return null;
    }
    const branch = currentBranch(state);
    const env = envBranch(state);
    const mode = modeOf(state, s.env);
    const behindCount = behind(state).length;
    const readOnly = editRefusal(state) !== null;
    const envTip = state.branches[env];
    const pendingHere = (b: string) => Object.keys(s.working[b] ?? {}).length;
    const merged = (b: string) => !!envTip && !!state.branches[b] && isAncestor(state, state.branches[b], envTip) && pendingHere(b) === 0;
    const visible = (b: string) => state.session.showMerged || !merged(b);
    const all = Object.keys(state.branches).sort();
    const kind = (b: string) => branchKind(state, b);
    const mine = all.filter(b => kind(b) === 'user' && ownerOf(b) === state.session.user && visible(b));
    const shared = all.filter(b => kind(b) === 'shared' && visible(b));
    const others = all.filter(b => kind(b) === 'user' && ownerOf(b) !== state.session.user && visible(b));
    const backports = all.filter(b => kind(b) === 'backport' && backportTarget(state, b) === s.env);
    const hotfixes = all.filter(b => kind(b) === 'hotfix' && visible(b));
    const environments = all.filter(b => kind(b) === 'environment' && b !== env);
    const removed = Object.keys(s.working).filter(b => !state.branches[b] && b !== '__postgres__' && pendingHere(b) > 0);
    const hiddenCount = all.filter(b => ['user', 'shared', 'hotfix'].includes(kind(b)) && merged(b)).length;
    const openPr = state.prs.find(p => p.state === 'open' && p.from === branch);
    const from = state.branches[base] ? base : branch;
    const carried = currentChanges(state).length;
    const bases = [env, ...all.filter(b => ['user', 'shared'].includes(kind(b)))];

    const item = (b: string, note?: string) => (
        <DropdownMenuItem key={b} onSelect={() => act(d => switchBranch(d, b))}>
            <Check className={cn(b === branch ? 'opacity-100' : 'opacity-0')} />
            <span className="flex-1 truncate font-mono text-xs">{b}</span>
            {merged(b) && <span className="text-[10px] text-muted-foreground">merged</span>}
            {note && <span className="text-[10px] text-muted-foreground">{note}</span>}
        </DropdownMenuItem>
    );
    const uncommitted = (b: string) => (pendingHere(b) ? `${pendingHere(b)} uncommitted` : undefined);
    const group = (label: string, branches: string[], note?: (b: string) => string | undefined) =>
        branches.length > 0 && (
            <>
                <DropdownMenuLabel className="text-xs text-muted-foreground">{label}</DropdownMenuLabel>
                {branches.map(b => item(b, note?.(b)))}
            </>
        );

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
                        {readOnly ? (
                            <Lock className="text-amber-600" />
                        ) : kind(branch) === 'hotfix' ? (
                            <Flame className="text-red-500" />
                        ) : (
                            <GitBranch />
                        )}
                        <span className="truncate">{branch}</span>
                        {behindCount > 0 && (
                            <span
                                className="rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-400"
                                title={`${behindCount} commits behind ${env}`}
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
                <DropdownMenuContent align="start" className="w-[26rem]">
                    <DropdownMenuLabel className="font-normal text-muted-foreground">
                        {s.env} server · {labelOf(state, s.env)} · <span className="font-mono">{env}</span> · {mode}
                    </DropdownMenuLabel>
                    {item(
                        env,
                        mode === 'direct'
                            ? 'direct edits = deploy'
                            : mode === 'pull-request'
                              ? 'pull requests only'
                              : 'promotion and hotfix PRs only',
                    )}
                    <DropdownMenuSeparator />
                    {mode === 'protected' ? (
                        <>
                            {group('Hotfix branches', hotfixes, uncommitted)}
                            {group('Backports into this environment', backports, uncommitted)}
                            {hotfixes.length + backports.length === 0 && (
                                <p className="px-2 py-1 text-xs text-muted-foreground">
                                    No hotfix or backport branch. Only those are edited here.
                                </p>
                            )}
                        </>
                    ) : (
                        <>
                            <DropdownMenuLabel className="text-xs text-muted-foreground">Your branches</DropdownMenuLabel>
                            {mine.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">None yet.</p>}
                            {mine.map(b => item(b, uncommitted(b)))}
                            {group('Shared work branches (anyone edits)', shared, uncommitted)}
                            {group('Backports into this environment', backports, uncommitted)}
                            {group("Others' branches (read only)", others)}
                        </>
                    )}
                    {removed.length > 0 && (
                        <>
                            <DropdownMenuLabel className="text-xs text-amber-600">
                                Removed on the remote, with your uncommitted changes
                            </DropdownMenuLabel>
                            {removed.map(b => item(b, uncommitted(b)))}
                        </>
                    )}
                    {group('Other environments (read only)', environments)}
                    <DropdownMenuSeparator />
                    {mode === 'protected' ? (
                        <DropdownMenuItem onSelect={() => setCreating('hotfix')}>
                            <Flame /> New hotfix branch…
                        </DropdownMenuItem>
                    ) : (
                        <DropdownMenuItem
                            onSelect={() => {
                                setBase(branch);
                                setCreating('branch');
                            }}
                        >
                            <Plus /> New branch…
                        </DropdownMenuItem>
                    )}
                    {(hiddenCount > 0 || state.session.showMerged) && (
                        <DropdownMenuItem
                            onSelect={e => {
                                e.preventDefault();
                                act(d => void (d.session.showMerged = !d.session.showMerged));
                            }}
                        >
                            {state.session.showMerged ? <EyeOff /> : <Eye />}{' '}
                            {state.session.showMerged ? 'Hide merged branches' : `Show merged branches (${hiddenCount})`}
                        </DropdownMenuItem>
                    )}
                    {['user', 'shared', 'hotfix'].includes(kind(branch)) && !readOnly && (
                        <DropdownMenuItem disabled={behindCount === 0} onSelect={startUpdate}>
                            <RefreshCw /> Update from {env}
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
                open={creating === 'branch'}
                title="New branch"
                description={
                    carried
                        ? `Only you write on it. Your uncommitted changes on ${branch} come along, as in git${branch === env || kind(branch) === 'shared' ? ' (only the files you edited last: the others stay, they are someone else’s)' : ''}.`
                        : 'Only you write on it.'
                }
                label="Name"
                prefix={`users/${state.session.user}/`}
                confirm="Create and switch"
                onClose={() => setCreating(null)}
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
                        {bases.map(b => (
                            <option key={b} value={b}>
                                {b} @ {state.branches[b]}
                                {b === env ? ` (${s.env})` : ''}
                            </option>
                        ))}
                    </select>
                    <p className="text-xs text-muted-foreground">Its pull request goes to {env}, the environment of this server.</p>
                </div>
            </NameDialog>
            <NameDialog
                open={creating === 'hotfix'}
                title="New hotfix branch"
                description={`Cut from ${env}. Its PR to ${env} is reviewed like a promotion; then ${s.env} is ahead of its source until the hotfix is back-ported.`}
                label="Name"
                prefix="hotfix/"
                confirm="Create and switch"
                onClose={() => setCreating(null)}
                onSubmit={name => act(d => createHotfix(d, name))}
            />
        </>
    );
}
