import { Folder as FolderIcon, Workflow } from 'lucide-react';
import { Link } from 'react-router';
import { flowPath } from '@/app/paths';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ProjectContents } from '@/data/flows/flow';
import { childrenOf, itemCount } from '@/data/flows/project-tree';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { DeployedChip } from '@/components/deployed-chip';
import { SchedulesChip } from '@/components/schedules-chip';
import { WebhooksChip } from '@/components/webhooks-chip';
import { WorkerTagChip } from '@/components/worker-tag-chip';
import { useTagColors } from '@/data/workers/use-tag-colors';
import { FlowMenu, FolderMenu, type ItemActions } from './item-menus';
import { useWorkspaceHandle } from '@/data/workspaces/use-workspace';

type Props = {
    contents: ProjectContents;
    projectId: string;
    /** the folder being shown; null = the project's root */
    folderId: string | null;
    actions: ItemActions;
};

const CARD = 'relative transition-colors hover:bg-accent/40 focus-within:ring-2 focus-within:ring-ring';
/** the link covers the whole card (after:inset-0); the "..." menu sits above it */
const COVER = "outline-none after:absolute after:inset-0 after:content-['']";

/** One folder's contents as cards: its folders first (a click goes into them), then its flows. */
export function CardsView({ contents, projectId, folderId, actions }: Props) {
    const ws = useWorkspaceHandle();
    // the tags' colors (WORKER_COLOR of their supervisors)
    const colors = useTagColors();
    const { folders, flows } = childrenOf(contents, folderId);
    if (folders.length === 0 && flows.length === 0) {
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-12 text-center">
                <FolderIcon className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{folderId ? 'This folder is empty.' : 'No flows yet.'}</p>
            </div>
        );
    }

    return (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {folders.map(folder => {
                const count = itemCount(contents, folder.id);
                return (
                    <Card key={folder.id} className={CARD}>
                        <CardHeader className="flex items-center gap-3">
                            <FolderIcon className="size-5 shrink-0 text-muted-foreground" />
                            <div className="grid min-w-0 flex-1 gap-1">
                                <CardTitle className="truncate">
                                    <button type="button" className={`text-left ${COVER}`} onClick={() => actions.openFolder(folder.id)}>
                                        {folder.name}
                                    </button>
                                </CardTitle>
                                <CardDescription>{count === 1 ? '1 item' : `${count} items`}</CardDescription>
                            </div>
                            <FolderMenu folder={folder} actions={actions} className="-mr-2" />
                        </CardHeader>
                    </Card>
                );
            })}

            {flows.map(flow => (
                <Card key={flow.id} className={CARD}>
                    <CardHeader className="flex items-center gap-3">
                        <Workflow className="size-5 shrink-0 text-muted-foreground" />
                        <div className="grid min-w-0 flex-1 gap-1">
                            <CardTitle className="truncate">
                                <Link to={flowPath(ws, projectId, flow.id)} className={COVER}>
                                    {flow.name}
                                </Link>
                            </CardTitle>
                            <div className="flex min-w-0 items-center gap-2">
                                <DeployedChip
                                    version={flow.archivedAt ? undefined : flow.deployedVersion}
                                    emergencyRollback={flow.emergencyRollback}
                                />
                                {!flow.archivedAt && <SchedulesChip schedules={flow.schedules} />}
                                {!flow.archivedAt && <WebhooksChip webhooks={flow.webhooks} />}
                                <WorkerTagChip tag={flow.workerTag} color={colors[flow.workerTag]} />
                                <CardDescription className="truncate" title={formatDateTime(flow.updatedAt)}>
                                    Updated {relativeTime(flow.updatedAt)}
                                    {(flow.updatedByName ?? flow.updatedBy) && ` by ${flow.updatedByName ?? flow.updatedBy}`}
                                </CardDescription>
                            </div>
                        </div>
                        <FlowMenu flow={flow} actions={actions} className="-mr-2" />
                    </CardHeader>
                </Card>
            ))}
        </div>
    );
}
