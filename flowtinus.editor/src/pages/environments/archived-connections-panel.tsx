import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { ConfirmDialog, type ConfirmTarget } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { deleteArchivedConnection, listArchivedConnections, type ArchivedConnection } from '@/data/git/git-api';
import { useResource } from '@/data/use-resource';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';

/** the archived connections, their configuration kept: an admin deletes one for good once its removal is committed */
export function ArchivedConnectionsPanel({ handle, canDelete }: { handle: string; canDelete: boolean }) {
    const archived = useResource(`archived-connections:${handle}`, () => listArchivedConnections(handle));
    const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
    const items = archived.state.status === 'ready' ? archived.state.value.items : [];
    if (items.length === 0) {
        return null;
    }

    const deleteForGood = (connection: ArchivedConnection) =>
        setConfirm({
            title: (
                <>
                    Delete <span className="font-semibold">{connection.name}</span> for good?
                </>
            ),
            description:
                'Its configuration is deleted and cannot be brought back: a commit that brings its id back brings it back unconfigured. The secrets it names stay.',
            confirmLabel: 'Delete for good',
            busyLabel: 'Deleting…',
            destructive: true,
            onConfirm: async () => {
                const result = await deleteArchivedConnection(handle, connection.id);
                if (result.ok) {
                    void archived.reload();
                }
                return result;
            },
        });

    return (
        <section className="grid gap-3">
            <h2 className="text-lg font-semibold">Archived connections</h2>
            <p className="text-sm text-muted-foreground">
                Removed by git, or deleted here and not committed yet: each keeps its configuration, and a commit that brings its id back
                brings it back configured.
            </p>
            <ul className="divide-y rounded-md border">
                {items.map(connection => (
                    <li key={connection.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                        <span className="font-medium">{connection.name}</span>
                        <span className="text-xs text-muted-foreground">{connection.type}</span>
                        <span className="text-xs text-muted-foreground" title={formatDateTime(new Date(connection.archivedAt))}>
                            archived {relativeTime(new Date(connection.archivedAt))}
                            {connection.archivedByName && ` · ${connection.archivedByName}`}
                        </span>
                        {connection.uncommitted && (
                            <span className="text-xs text-amber-600 dark:text-amber-400">Delete not committed yet</span>
                        )}
                        {canDelete && (
                            <Button
                                className="ml-auto"
                                variant="ghost"
                                size="sm"
                                disabled={connection.uncommitted}
                                title={connection.uncommitted ? 'Commit its Delete, or discard it, first' : undefined}
                                onClick={() => deleteForGood(connection)}
                            >
                                <Trash2 /> Delete for good
                            </Button>
                        )}
                    </li>
                ))}
            </ul>
            <ConfirmDialog target={confirm} onClose={() => setConfirm(null)} />
        </section>
    );
}
