import { Archive, ArchiveRestore, CircleAlert, CircleCheck, Copy, LoaderCircle, Pencil, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { DraftSave } from '@/editor/flow-save';

/**
 * Where the flow's draft stands, in the top bar: Editing… (a save waits for the changes to settle), Saving…, Saved,
 * Unsaved changes (in red: the save failed, with Retry), or changed elsewhere (with
 * Reload), archived or removed (nothing to retry). It saves by itself; Ctrl+S saves now. An archived flow (`archived`,
 * read-only) shows Archived and Restore instead.
 */
export function SaveStatus({
    save,
    archived,
    disk,
}: {
    save: DraftSave | null;
    archived?: { onRestore: () => void; restoring: boolean; error?: string };
    /** on a local server, what a conflict with the file on disk offers: never an overwrite */
    disk?: { onReload: () => void; onSaveAsNew: () => void };
}) {
    if (archived) {
        return (
            <span className="flex items-center gap-1.5">
                <Status
                    icon={<Archive className="size-3.5 text-amber-600 dark:text-amber-400" />}
                    text={archived.error ? `Archived: ${archived.error}` : 'Archived (read-only)'}
                    title="This flow is archived: it opens to read, nothing is saved or run. Restore it to change it."
                />
                <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={archived.restoring} onClick={archived.onRestore}>
                    {archived.restoring ? <LoaderCircle className="animate-spin" /> : <ArchiveRestore />} Restore
                </Button>
            </span>
        );
    }

    if (!save) {
        return null;
    }

    const { state } = save;
    switch (state.status) {
        case 'loading':
            return <Status icon={<LoaderCircle className="size-3.5 animate-spin" />} text="Opening…" />;
        case 'pending':
            return (
                <Status
                    icon={<Pencil className="size-3.5" />}
                    text="Editing…"
                    title="Saves by itself a moment after the last change; Ctrl+S saves now"
                />
            );
        case 'saving':
            return <Status icon={<LoaderCircle className="size-3.5 animate-spin" />} text="Saving…" />;
        case 'saved':
            return (
                <Status
                    icon={<CircleCheck className="size-3.5 text-green-600 dark:text-green-400" />}
                    text="Saved"
                    title="Saved (it saves by itself; Ctrl+S saves now)"
                />
            );
        case 'error':
            return (
                <span className="flex items-center gap-1.5">
                    <Status
                        icon={<CircleAlert className="size-3.5" />}
                        text="Unsaved changes"
                        title={`Not saved: ${state.message}`}
                        className="text-destructive"
                    />
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={save.saveNow}>
                        Retry
                    </Button>
                </span>
            );
        case 'gone':
            return (
                <Status
                    icon={<CircleAlert className="size-3.5 text-destructive" />}
                    text="This flow was archived or removed"
                    title="This flow was archived or removed: your changes here are not saved"
                />
            );
        case 'read-only':
            return null;
        case 'conflict':
            return disk ? (
                <span className="flex items-center gap-1.5">
                    <Status
                        icon={<CircleAlert className="size-3.5 text-amber-600 dark:text-amber-400" />}
                        text="Changed on disk"
                        title="The file changed on disk and cannot be merged with your changes: they are not saved"
                    />
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={disk.onReload}>
                        <RefreshCw /> Reload from disk
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={disk.onSaveAsNew}>
                        <Copy /> Save as a new flow
                    </Button>
                </span>
            ) : (
                <span className="flex items-center gap-1.5">
                    <Status
                        icon={<CircleAlert className="size-3.5 text-amber-600 dark:text-amber-400" />}
                        text="Changed elsewhere"
                        title="This flow was changed elsewhere: reload it to see the latest version (your changes here are not saved)"
                    />
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={save.reload}>
                        <RefreshCw /> Reload
                    </Button>
                </span>
            );
    }
}

function Status({ icon, text, title, className }: { icon: React.ReactNode; text: string; title?: string; className?: string }) {
    return (
        <span role="status" title={title ?? text} className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
            {icon}
            {text}
        </span>
    );
}
