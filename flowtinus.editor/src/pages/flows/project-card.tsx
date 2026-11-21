import { Archive, ArchiveRestore, Ellipsis, FolderInput, FileCode2, Pencil, Rocket, Workflow, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { projectPath } from '@/app/paths';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { summaryItems, type Project, type SummaryItem } from '@/data/projects/project';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ProjectIcon } from './project-icon';
import { useWorkspace } from '@/data/workspaces/use-workspace';

/** each part of the summary with its tab's icon */
const SUMMARY_ICONS: Record<SummaryItem['key'], LucideIcon> = {
    flows: Workflow,
    deployed: Rocket,
    scripts: FileCode2,
};

type Props = {
    project: Project;
    onEdit: () => void;
    onArchive: () => void;
    onRestore: () => void;
    /** to another workspace (admins of this one) */
    onMove?: () => void;
};

/**
 * A project in the list: a click anywhere opens its flows (/projects/:projectId/flows); the "..." menu (Edit and Archive while
 * active, Restore once archived) sits above that link.
 */
export function ProjectCard({ project, onEdit, onArchive, onRestore, onMove }: Props) {
    const { handle: ws, canEdit, isAdmin } = useWorkspace();
    const archived = project.archivedAt !== null;

    return (
        <Card
            className={cn(
                'relative transition-colors hover:bg-accent/40 focus-within:ring-2 focus-within:ring-ring',
                archived && 'opacity-75',
            )}
        >
            <CardHeader className="flex items-start gap-3">
                <ProjectIcon icon={project.icon} color={project.color} className={cn(archived && 'grayscale')} />
                <div className="grid min-w-0 flex-1 gap-1">
                    <CardTitle className="truncate">
                        {/* the link covers the whole card (after:inset-0) */}
                        <Link to={projectPath(ws, project.id)} className="outline-none after:absolute after:inset-0 after:content-['']">
                            {project.name}
                        </Link>
                    </CardTitle>
                    {/* always two lines high (so the summary below is at the same place in every card), "…" past them */}
                    <CardDescription className="line-clamp-2 h-10 leading-5" title={project.description || undefined}>
                        {project.description || 'No description'}
                    </CardDescription>
                </div>
                {canEdit && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="relative z-10 -mt-1 -mr-2 size-8 shrink-0"
                                aria-label={`Actions for ${project.name}`}
                            >
                                <Ellipsis />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {archived ? (
                                <DropdownMenuItem onSelect={onRestore}>
                                    <ArchiveRestore /> Restore
                                </DropdownMenuItem>
                            ) : (
                                <>
                                    <DropdownMenuItem onSelect={onEdit}>
                                        <Pencil /> Edit
                                    </DropdownMenuItem>
                                    {isAdmin && onMove && (
                                        <DropdownMenuItem onSelect={onMove}>
                                            <FolderInput /> Move to workspace
                                        </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem onSelect={onArchive}>
                                        <Archive /> Archive
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </CardHeader>
            {project.summary && (
                <CardContent className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                    {summaryItems(project.summary).map(item => {
                        const Icon = SUMMARY_ICONS[item.key];
                        return (
                            <span key={item.title} className="inline-flex items-center gap-1.5" title={item.title}>
                                <Icon className="size-3.5" />
                                {item.text}
                            </span>
                        );
                    })}
                </CardContent>
            )}
            {/* the date at the bottom, even when the descriptions have different lengths */}
            <CardFooter className="mt-auto text-xs text-muted-foreground/70">
                {project.archivedAt ? `Archived ${formatDate(project.archivedAt)}` : `Created ${formatDate(project.createdAt)}`}
            </CardFooter>
        </Card>
    );
}
