import type { ReactNode } from 'react';
import type { ApiResult } from '@/lib/api';
import { ConfirmDialog } from './confirm-dialog';

type Props = {
    /** what is being archived (a project, a flow); null = closed */
    name: string | null;
    onClose: () => void;
    onArchive: () => Promise<ApiResult<unknown>>;
    /** what else it says: e.g. the flows that go with a folder */
    description?: ReactNode;
    /** highlighted: e.g. the deploys, schedules and webhooks that will be turned off */
    warning?: ReactNode;
};

/** "Archive <name>?" before archiving; an error shows here and keeps it open. */
export function ArchiveDialog({ name, onClose, onArchive, description, warning }: Props) {
    return (
        <ConfirmDialog
            target={
                name === null
                    ? null
                    : {
                          title: `Archive ${name}?`,
                          description: description ?? 'It moves to Archived and can be restored.',
                          warning,
                          confirmLabel: 'Archive',
                          busyLabel: 'Archiving...',
                          onConfirm: onArchive,
                      }
            }
            onClose={onClose}
        />
    );
}
