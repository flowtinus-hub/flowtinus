import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import { projectsPath } from '@/app/paths';
import { useWorkspace } from '@/data/workspaces/use-workspace';

/** Workspace › Title: the workspace (a link to its projects) and the page */
export function WorkspaceBreadcrumb({ title }: { title: string }) {
    const { slug, membership } = useWorkspace();
    return (
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            <Link to={projectsPath(slug)} className="min-w-0 truncate text-muted-foreground hover:text-foreground">
                {membership?.name ?? slug}
            </Link>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        </nav>
    );
}
