import { useEffect, useRef } from 'react';
import { ChevronRight, Folder as FolderIcon, FolderOpen, Workflow } from 'lucide-react';
import { Link } from 'react-router';
import { flowPath } from '@/app/paths';
import type { ProjectContents } from '@/data/flows/flow';
import { childrenOf, itemCount } from '@/data/flows/project-tree';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';
import { DeployedChip } from '@/components/deployed-chip';
import { SchedulesChip } from '@/components/schedules-chip';
import { WebhooksChip } from '@/components/webhooks-chip';
import { WorkerTagChip } from '@/components/worker-tag-chip';
import { useTagColors } from '@/data/workers/use-tag-colors';
import { FlowMenu, FolderMenu, type ItemActions } from './item-menus';
import { useWorkspaceSlug } from '@/data/workspaces/use-workspace';

type Props = {
    contents: ProjectContents;
    projectId: string;
    /** the folders shown open */
    expanded: Set<string>;
    onToggle: (folderId: string) => void;
    actions: ItemActions;
    /** the folder the page was opened on (?folder=): marked, and scrolled to */
    current?: string | null;
};

const ROW = 'group relative flex items-center gap-2 py-1.5 pr-2 transition-colors hover:bg-accent/40 focus-within:bg-accent/40';
const indent = (depth: number) => ({ paddingLeft: `${0.75 + depth * 1.25}rem` });

/** The whole project as a tree: folders open and close (chevron), flows are the leaves. */
export function TreeView({ contents, projectId, expanded, onToggle, actions, current = null }: Props) {
    const root = childrenOf(contents, null);
    if (root.folders.length === 0 && root.flows.length === 0) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-12 text-center">
                <Workflow className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No flows yet.</p>
            </div>
        );
    }

    return (
        <ul role="tree" aria-label="Folders and flows" className="overflow-hidden rounded-xl border bg-card py-1">
            <Level {...{ contents, projectId, expanded, onToggle, actions, current }} folderId={null} depth={0} />
        </ul>
    );
}

function Level({
    contents,
    projectId,
    expanded,
    onToggle,
    actions,
    current,
    folderId,
    depth,
}: Props & { folderId: string | null; depth: number }) {
    const ws = useWorkspaceSlug();
    // the tags' colors (WORKER_COLOR of their supervisors)
    const colors = useTagColors();
    const { folders, flows } = childrenOf(contents, folderId);

    return (
        <>
            {folders.map(folder => {
                const open = expanded.has(folder.id);
                const count = itemCount(contents, folder.id);
                return (
                    <li key={folder.id} role="treeitem" aria-expanded={open} aria-label={folder.name}>
                        <div
                            className={cn(ROW, folder.id === current && 'bg-accent/60')}
                            style={indent(depth)}
                            {...(folder.id === current ? { 'aria-current': 'location' as const } : {})}
                        >
                            {folder.id === current && <ScrollHere />}
                            <button
                                type="button"
                                onClick={() => onToggle(folder.id)}
                                className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none after:absolute after:inset-0 after:content-['']"
                            >
                                <ChevronRight
                                    className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
                                />
                                {open ? (
                                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                                ) : (
                                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                                )}
                                <span className="truncate font-medium">{folder.name}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">{count === 1 ? '1 item' : `${count} items`}</span>
                            </button>
                            <FolderMenu folder={folder} actions={actions} />
                        </div>
                        {open && (
                            <ul role="group">
                                <Level
                                    {...{ contents, projectId, expanded, onToggle, actions, current }}
                                    folderId={folder.id}
                                    depth={depth + 1}
                                />
                            </ul>
                        )}
                    </li>
                );
            })}

            {flows.map(flow => (
                <li key={flow.id} role="treeitem" aria-label={flow.name}>
                    {/* the chevron's room, so flow names line up with folder names */}
                    <div className={ROW} style={indent(depth)}>
                        <span className="size-4 shrink-0" />
                        <Workflow className="size-4 shrink-0 text-muted-foreground" />
                        <Link
                            to={flowPath(ws, projectId, flow.id)}
                            className="min-w-0 flex-1 truncate outline-none after:absolute after:inset-0 after:content-['']"
                        >
                            {flow.name}
                        </Link>
                        <DeployedChip version={flow.archivedAt ? undefined : flow.deployedVersion} />
                        {!flow.archivedAt && <SchedulesChip schedules={flow.schedules} />}
                        {!flow.archivedAt && <WebhooksChip webhooks={flow.webhooks} />}
                        <WorkerTagChip tag={flow.workerTag} color={colors[flow.workerTag]} />
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline" title={formatDateTime(flow.updatedAt)}>
                            Updated {relativeTime(flow.updatedAt)} by {flow.updatedByName ?? flow.updatedBy}
                        </span>
                        <FlowMenu flow={flow} actions={actions} />
                    </div>
                </li>
            ))}
        </>
    );
}

/** scrolls its row into view once, when it shows (the folder the page was opened on) */
function ScrollHere() {
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        ref.current?.parentElement?.scrollIntoView?.({ block: 'center' });
    }, []);

    return <span ref={ref} hidden />;
}
