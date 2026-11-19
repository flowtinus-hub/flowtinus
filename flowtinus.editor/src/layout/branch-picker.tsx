import { Check, ChevronsUpDown, GitBranch, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { projectsPath } from '@/app/paths';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { getCurrentBranch, listBranches, setCurrentBranch, type BranchInfo, type BranchKind, type CurrentBranch } from '@/data/git/git-api';

const GROUPS: { kind: BranchKind; label: string }[] = [
    { kind: 'environment', label: 'Environments' },
    { kind: 'user', label: "Users' branches" },
    { kind: 'shared', label: 'Shared branches' },
];

function BranchItem({ branch, current, onPick }: { branch: BranchInfo; current: string | null; onPick: (name: string) => void }) {
    const who = branch.kind === 'user' ? (branch.mine ? 'yours' : (branch.ownerName ?? branch.owner)) : undefined;
    return (
        <DropdownMenuItem onSelect={() => onPick(branch.name)} title={branch.editable ? branch.name : `${branch.name} (read only here)`}>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{branch.name}</span>
            {who && <span className="shrink-0 text-xs text-muted-foreground">{who}</span>}
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

/**
 * With git on, the branch the user is on in this workspace; a click lists the remote's branches by kind (merged ones
 * behind "Show merged") and picks one: the projects and flows then answer for it. One the user cannot edit opens read only.
 */
export function BranchPicker({ slug }: { slug: string }) {
    const { isMobile } = useSidebar();
    const [current, setCurrent] = useState<{ slug: string; value: CurrentBranch } | null>(null);
    const [branches, setBranches] = useState<{ slug: string; list: BranchInfo[]; error?: string } | null>(null);
    const [showMerged, setShowMerged] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        let gone = false;
        void getCurrentBranch(slug).then(result => !gone && result.ok && setCurrent({ slug, value: result.value }));
        return () => {
            gone = true;
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
            setBranches(result.ok ? { slug, list: result.value.branches } : { slug, list: [], error: result.error.message }),
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
        // every page read so far was the other branch's: the projects again, from scratch, on this one
        window.location.assign(projectsPath(slug));
    };

    const list = branches?.slug === slug ? branches.list : [];
    const merged = list.filter(b => b.merged && b.name !== value.branch);
    const shown = list.filter(b => showMerged || !b.merged || b.name === value.branch);
    const label = value.editable ? `On ${value.branch}` : `On ${value.branch} (read only)`;

    return (
        <SidebarMenuItem>
            <DropdownMenu onOpenChange={load}>
                <DropdownMenuTrigger asChild>
                    <SidebarMenuButton
                        tooltip={label}
                        className="text-muted-foreground"
                        aria-label={`Current branch: ${value.branch}. Pick a branch`}
                    >
                        <GitBranch />
                        <span className="truncate font-mono text-xs">{value.branch}</span>
                        {!value.editable && <Lock className="size-3 shrink-0" aria-label="Read only" />}
                        <ChevronsUpDown className="ml-auto group-data-[collapsible=icon]:hidden" />
                    </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-80" side={isMobile ? 'bottom' : 'right'} align="start">
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
            {error && <p className="px-2 text-xs text-destructive group-data-[collapsible=icon]:hidden">{error}</p>}
        </SidebarMenuItem>
    );
}
