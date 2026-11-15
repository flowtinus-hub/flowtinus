import type { ReactNode } from 'react';
import { WorkspaceBreadcrumb } from './workspace-breadcrumb';

type Props = {
    /** the page's title, after the workspace in the breadcrumb */
    title: string;
    /** the page's buttons (New ...), next to the title */
    actions?: ReactNode;
    children: ReactNode;
};

/** A page of the workspace itself (Projects, Connections, Secrets and Variables, Settings): Workspace › Title and its buttons. */
export function WorkspacePage({ title, actions, children }: Props) {
    return (
        <div className="mx-auto flex w-full max-w-screen-2xl flex-1 flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <WorkspaceBreadcrumb title={title} />
                {actions && <div className="flex gap-2">{actions}</div>}
            </div>
            {children}
        </div>
    );
}
