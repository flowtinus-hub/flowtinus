import { Check, ChevronsUpDown, Flame, GitBranch, GitBranchPlus, GitMerge, GitPullRequestArrow, Lock, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { CHANGES_CHANGED, getCurrentBranch, GIT_STATUS_CHANGED, listBranches, opensIntoEnvironment, removedBranchText, setCurrentBranch, type BranchInfo, type BranchKind, type CurrentBranch, type MergeRequestLink, type Mode } from '@/data/git/git-api';
import { useMe, useWorkspace } from '@/data/workspaces/use-workspace';
import { useUnsavedWork } from '@/data/git/unsaved-work';
import { cn } from '@/lib/utils';
import { landAfterSwitch } from './branch-landing';
import { CreateBranchDialog } from './create-branch-dialog';
import { CreateHotfixDialog } from './create-hotfix-dialog';
import { PullRequestDialog } from './pull-request-dialog';
import { UpdateDialog } from './update-dialog';

const GROUPS: { kind: BranchKind; label: string }[] = [
    { kind: 'environment', label: 'Environments' },
    { kind: 'hotfix', label: 'Hotfixes' },
    { kind: 'user', label: "Users' branches" },
    { kind: 'shared', label: 'Shared branches' },
    { kind: 'backport', label: 'Backports' },
];

function MergeRequestBadge({ mergeRequest }: { mergeRequest: MergeRequestLink }) {
    return (
        <a
            className="shrink-0 font-mono text-xs text-muted-foreground underline hover:text-foreground"
            href={mergeRequest.url}
            target="_blank"
            rel="noreferrer"
            title={`Open merge request !${mergeRequest.number}`}
            onClick={event => event.stopPropagation()}
        >
            !{mergeRequest.number}
        </a>
    );
}

function BranchItem({ branch, current, onPick }: { branch: BranchInfo; current: string | null; onPick: (name: string) => void }) {
    const who = branch.kind === 'user' ? (branch.mine ? 'yours' : (branch.ownerName ?? branch.owner)) : undefined;
    return (
        <DropdownMenuItem
            onSelect={() => onPick(branch.name)}
            title={
                branch.removed
                    ? `${branch.name}: ${removedBranchText(branch.lostTip)}`
                    : branch.editable
                      ? branch.name
                      : `${branch.name} (read only here)`
            }
        >
            <span className={cn('min-w-0 flex-1 truncate font-mono text-xs', branch.removed && 'line-through')}>{branch.name}</span>
            {branch.removed && <span className="shrink-0 text-xs text-destructive">removed</span>}
            {who && <span className="shrink-0 text-xs text-muted-foreground">{who}</span>}
            {branch.merged && <span className="shrink-0 text-xs text-muted-foreground">merged</span>}
            {branch.mergeRequest && <MergeRequestBadge mergeRequest={branch.mergeRequest} />}
            {branch.changes > 0 && (
                <span className="shrink-0 text-xs text-muted-foreground" title={`${branch.changes} uncommitted on this server`}>
                    {branch.changes}
                </span>
            )}
            {!branch.editable && <Lock className="size-3 text-muted-foreground" aria-label="Read only" />}
            {branch.name === current && <Check />}
        </DropdownMenuItem>
    );
}

export function BranchPicker({ handle }: { handle: string }) {
    const [current, setCurrent] = useState<{ handle: string; value: CurrentBranch } | null>(null);
    const [branches, setBranches] = useState<{
        handle: string;
        list: BranchInfo[];
        environment?: string | null;
        mode?: Mode;
        error?: string;
    } | null>(null);
    const listedOnMount = useRef<string | null>(null);
    const [showMerged, setShowMerged] = useState(false);
    const [error, setError] = useState('');
    const [creating, setCreating] = useState(false);
    const [hotfixing, setHotfixing] = useState(false);
    const [proposing, setProposing] = useState(false);
    const [updating, setUpdating] = useState(false);
    const { state } = useMe();
    const { canEdit } = useWorkspace();
    const unsaved = useUnsavedWork();
    const userHandle = state.status === 'ready' ? state.me.handle : null;

    useEffect(() => {
        let gone = false;
        const read = () => void getCurrentBranch(handle).then(result => !gone && result.ok && setCurrent({ handle, value: result.value }));
        read();
        window.addEventListener(GIT_STATUS_CHANGED, read);
        return () => {
            gone = true;
            window.removeEventListener(GIT_STATUS_CHANGED, read);
        };
    }, [handle]);

    useEffect(() => {
        let gone = false;
        const list = () => {
            listedOnMount.current = handle;
            void listBranches(handle).then(
                result =>
                    !gone &&
                    result.ok &&
                    setBranches({ handle, list: result.value.branches, environment: result.value.environment, mode: result.value.mode }),
            );
        };
        list();
        const events = [CHANGES_CHANGED, GIT_STATUS_CHANGED];
        events.forEach(event => window.addEventListener(event, list));
        return () => {
            gone = true;
            events.forEach(event => window.removeEventListener(event, list));
        };
    }, [handle]);

    const value = current?.handle === handle ? current.value : null;
    if (!value?.branch) {
        return null;
    }

    const load = (open: boolean) => {
        if (!open) {
            return;
        }
        setError('');
        if (listedOnMount.current === handle) {
            listedOnMount.current = null;
            return;
        }
        void listBranches(handle).then(result =>
            setBranches(
                result.ok
                    ? { handle, list: result.value.branches, environment: result.value.environment, mode: result.value.mode }
                    : { handle, list: [], error: result.error.message },
            ),
        );
    };
    const pick = async (name: string) => {
        if (name === value.branch) {
            return;
        }
        const result = await setCurrentBranch(handle, name);
        if (!result.ok) {
            setError(result.error.message);
            return;
        }
        await landAfterSwitch(handle);
    };

    const list = branches?.handle === handle ? branches.list : [];
    const merged = list.filter(b => b.merged && b.name !== value.branch);
    const shown = list.filter(b => showMerged || !b.merged || b.name === value.branch);
    const label = value.removed
        ? `On ${value.branch}. ${removedBranchText(value.lostTip)}`
        : value.editable
          ? `On ${value.branch}`
          : `On ${value.branch} (read only)`;
    const environment = branches?.handle === handle ? branches.environment : null;
    const work = list.find(b => b.name === value.branch && b.kind !== 'environment');
    const updatable = canEdit && environment && work?.editable ? work : null;
    const pushable = work?.removed && (work.kind === 'shared' || work.mine) ? work : null;
    const protectedHere = branches?.handle === handle && branches.mode === 'protected';
    const reviewing = list.find(b => b.name === value.branch)?.mergeRequest;
    const proposable = canEdit && environment && (!protectedHere || opensIntoEnvironment(work?.kind)) ? (updatable ?? pushable) : null;

    return (
        <>
            <DropdownMenu onOpenChange={load}>
                <DropdownMenuTrigger asChild disabled={!!unsaved}>
                    <Button
                        variant="ghost"
                        size="sm"
                        title={unsaved ? `${label}. ${unsaved} to switch branches` : label}
                        className={cn(
                            'min-w-0 max-w-72 text-muted-foreground',
                            unsaved && 'disabled:pointer-events-auto disabled:cursor-not-allowed',
                        )}
                        aria-label={`Current branch: ${value.branch}. Pick a branch`}
                    >
                        <GitBranch />
                        <span className={cn('truncate font-mono text-xs', value.removed && 'line-through')}>{value.branch}</span>
                        {value.removed ? (
                            <TriangleAlert className="size-3 shrink-0 text-destructive" aria-label={removedBranchText(value.lostTip)} />
                        ) : (
                            !value.editable && <Lock className="size-3 shrink-0" aria-label="Read only" />
                        )}
                        <ChevronsUpDown />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-80" side="bottom" align="start">
                    {branches?.handle !== handle && (
                        <DropdownMenuLabel className="text-xs text-muted-foreground">Loading branches...</DropdownMenuLabel>
                    )}
                    {branches?.error && <DropdownMenuLabel className="text-xs text-destructive">{branches.error}</DropdownMenuLabel>}
                    {GROUPS.map(({ kind, label: title }) => {
                        const items = shown.filter(b => b.kind === kind);
                        return (
                            items.length > 0 && (
                                <div key={kind}>
                                    <DropdownMenuLabel className="text-xs text-muted-foreground">{title}</DropdownMenuLabel>
                                    {items.map(b => (
                                        <BranchItem key={b.name} branch={b} current={value.branch} onPick={name => void pick(name)} />
                                    ))}
                                </div>
                            )
                        );
                    })}
                    {canEdit && protectedHere && environment && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => setHotfixing(true)}>
                                <Flame />
                                Create hotfix...
                            </DropdownMenuItem>
                        </>
                    )}
                    {canEdit && !protectedHere && userHandle && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => setCreating(true)}>
                                <GitBranchPlus />
                                Create branch...
                            </DropdownMenuItem>
                        </>
                    )}
                    {updatable && (
                        <DropdownMenuItem onSelect={() => setUpdating(true)}>
                            <GitMerge />
                            Update from {environment}...
                        </DropdownMenuItem>
                    )}
                    {proposable &&
                        (proposable.merged ? (
                            <DropdownMenuItem disabled>
                                <GitMerge />
                                Merged into {environment}
                            </DropdownMenuItem>
                        ) : reviewing ? (
                            <DropdownMenuItem asChild>
                                <a href={reviewing.url} target="_blank" rel="noreferrer">
                                    <GitPullRequestArrow />
                                    Merge request !{reviewing.number} to {environment}
                                </a>
                            </DropdownMenuItem>
                        ) : (
                            <DropdownMenuItem onSelect={() => setProposing(true)}>
                                <GitPullRequestArrow />
                                Open a pull request to {environment}...
                            </DropdownMenuItem>
                        ))}
                    {merged.length > 0 && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuCheckboxItem
                                checked={showMerged}
                                onSelect={event => event.preventDefault()}
                                onCheckedChange={checked => setShowMerged(checked === true)}
                            >
                                Show merged ({merged.length})
                            </DropdownMenuCheckboxItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            {reviewing && <MergeRequestBadge mergeRequest={reviewing} />}
            {error && (
                <span className="max-w-64 truncate text-xs text-destructive" title={error}>
                    {error}
                </span>
            )}
            {proposing && proposable && environment && (
                <PullRequestDialog
                    handle={handle}
                    branch={proposable.name}
                    target={environment}
                    uncommitted={proposable.changes}
                    onClose={() => setProposing(false)}
                />
            )}
            {updating && <UpdateDialog handle={handle} onClose={() => setUpdating(false)} />}
            {hotfixing && environment && (
                <CreateHotfixDialog handle={handle} environment={environment} onClose={() => setHotfixing(false)} />
            )}
            {creating && userHandle && (
                <CreateBranchDialog
                    handle={handle}
                    from={value.branch}
                    lostTip={value.lostTip}
                    userHandle={userHandle}
                    onClose={() => setCreating(false)}
                />
            )}
        </>
    );
}
