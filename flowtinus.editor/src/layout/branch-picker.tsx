import { Check, ChevronsUpDown, GitBranch, GitBranchPlus, GitMerge, GitPullRequestArrow, Lock, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { getCurrentBranch, GIT_STATUS_CHANGED, listBranches, removedBranchText, setCurrentBranch, type BranchInfo, type BranchKind, type CurrentBranch, type Mode } from '@/data/git/git-api';
import { useMe, useWorkspace } from '@/data/workspaces/use-workspace';
import { useUnsavedWork } from '@/data/git/unsaved-work';
import { cn } from '@/lib/utils';
import { landingAfterSwitch, noteBranchSwitch } from './branch-landing';
import { CreateBranchDialog } from './create-branch-dialog';
import { PullRequestDialog } from './pull-request-dialog';
import { UpdateDialog } from './update-dialog';

const GROUPS: { kind: BranchKind; label: string }[] = [
    { kind: 'environment', label: 'Environments' },
    { kind: 'user', label: "Users' branches" },
    { kind: 'shared', label: 'Shared branches' },
];

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

export function BranchPicker({ slug }: { slug: string }) {
    const [current, setCurrent] = useState<{ slug: string; value: CurrentBranch } | null>(null);
    const [branches, setBranches] = useState<{
        slug: string;
        list: BranchInfo[];
        environment?: string | null;
        mode?: Mode;
        error?: string;
    } | null>(null);
    const [showMerged, setShowMerged] = useState(false);
    const [error, setError] = useState('');
    const [creating, setCreating] = useState(false);
    const [proposing, setProposing] = useState(false);
    const [updating, setUpdating] = useState(false);
    const { state } = useMe();
    const { canEdit } = useWorkspace();
    const unsaved = useUnsavedWork();
    const handle = state.status === 'ready' ? state.me.handle : null;

    useEffect(() => {
        let gone = false;
        const read = () => void getCurrentBranch(slug).then(result => !gone && result.ok && setCurrent({ slug, value: result.value }));
        read();
        window.addEventListener(GIT_STATUS_CHANGED, read);
        return () => {
            gone = true;
            window.removeEventListener(GIT_STATUS_CHANGED, read);
        };
    }, [slug]);

    const value = current?.slug === slug ? current.value : null;
    if (!value?.branch) {
        return null;
    }

    const load = (open: boolean) => {
        if (!open) {
            return;
        }
        setError('');
        void listBranches(slug).then(result =>
            setBranches(
                result.ok
                    ? { slug, list: result.value.branches, environment: result.value.environment, mode: result.value.mode }
                    : { slug, list: [], error: result.error.message },
            ),
        );
    };
    const pick = async (name: string) => {
        if (name === value.branch) {
            return;
        }
        const result = await setCurrentBranch(slug, name);
        if (!result.ok) {
            setError(result.error.message);
            return;
        }
        noteBranchSwitch();
        // every page read so far was the other branch's: the page again, from scratch, on this one
        window.location.assign(await landingAfterSwitch(slug));
    };

    const list = branches?.slug === slug ? branches.list : [];
    const merged = list.filter(b => b.merged && b.name !== value.branch);
    const shown = list.filter(b => showMerged || !b.merged || b.name === value.branch);
    const label = value.removed
        ? `On ${value.branch}. ${removedBranchText(value.lostTip)}`
        : value.editable
          ? `On ${value.branch}`
          : `On ${value.branch} (read only)`;
    const environment = branches?.slug === slug ? branches.environment : null;
    const work = list.find(b => b.name === value.branch && b.kind !== 'environment');
    const updatable = canEdit && environment && work?.editable ? work : null;
    const pushable = work?.removed && (work.kind === 'shared' || work.mine) ? work : null;
    const proposable = canEdit && environment && branches?.mode !== 'protected' ? (updatable ?? pushable) : null;

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
                    {branches?.slug !== slug && (
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
                    {canEdit && handle && (
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
            {error && (
                <span className="max-w-64 truncate text-xs text-destructive" title={error}>
                    {error}
                </span>
            )}
            {proposing && proposable && environment && (
                <PullRequestDialog
                    slug={slug}
                    branch={proposable.name}
                    target={environment}
                    uncommitted={proposable.changes}
                    onClose={() => setProposing(false)}
                />
            )}
            {updating && <UpdateDialog slug={slug} onClose={() => setUpdating(false)} />}
            {creating && handle && (
                <CreateBranchDialog
                    slug={slug}
                    from={value.branch}
                    lostTip={value.lostTip}
                    handle={handle}
                    onClose={() => setCreating(false)}
                />
            )}
        </>
    );
}
