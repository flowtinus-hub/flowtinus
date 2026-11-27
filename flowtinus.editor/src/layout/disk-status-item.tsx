import { useState } from 'react';
import { FolderX, TriangleAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import type { DiskStatus } from '@/data/git/git-api';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { Issues } from '@/pages/environments/git-status-panel';

function When({ at }: { at: string }) {
    return <span title={relativeTime(new Date(at))}>{formatDateTime(new Date(at))}</span>;
}

// no Reconcile now on a local server: the next change on disk retries
export function DiskStatusItem({ disk }: { disk: DiskStatus }) {
    const [open, setOpen] = useState(false);
    if (disk.gone) {
        const label = 'Folder gone from disk';
        return (
            <SidebarMenuItem>
                <SidebarMenuButton
                    tooltip={label}
                    className="text-amber-700 dark:text-amber-400"
                    title={`Not on the disk since ${formatDateTime(new Date(disk.gone))}: no longer reconciled, nothing of it deleted`}
                >
                    <FolderX />
                    <span>{label}</span>
                </SidebarMenuButton>
            </SidebarMenuItem>
        );
    }
    if (!disk.refused) {
        return null;
    }

    const label = 'The disk is not valid';
    return (
        <SidebarMenuItem>
            <SidebarMenuButton tooltip={label} className="text-amber-700 dark:text-amber-400" onClick={() => setOpen(true)}>
                <TriangleAlert />
                <span>{label}</span>
            </SidebarMenuButton>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>The disk is not valid</DialogTitle>
                        <DialogDescription>
                            The disk is not valid since <When at={disk.refused.since} />;{' '}
                            {disk.appliedAt ? (
                                <>
                                    running the tree from <When at={disk.appliedAt} />.
                                </>
                            ) : (
                                'no tree from it has run yet.'
                            )}{' '}
                            Fix the files below: the next change on disk is read again.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="max-h-96 overflow-y-auto">
                        <Issues issues={disk.refused.errors} tone="error" />
                    </div>
                </DialogContent>
            </Dialog>
        </SidebarMenuItem>
    );
}
