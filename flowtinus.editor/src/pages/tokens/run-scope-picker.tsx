import { useEffect, useState } from 'react';
import { Folder as FolderIcon, Workflow, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { Flow, Folder, ProjectContents } from '@/data/flows/flow';
import { getProjectContents } from '@/data/flows/flows-api';
import { childrenOf, folderPath } from '@/data/flows/project-tree';
import type { Project } from '@/data/projects/project';
import { listProjects } from '@/data/projects/projects-api';
import { pickedOf, type PickedItem } from '@/data/tokens/api-token';
import type { Membership } from '@/data/workspaces/workspace';
import { cn } from '@/lib/utils';

const SELECT =
    'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/30';

/** the folders above a folder (or a flow's folder), its own excluded */
const ancestors = (folders: Folder[], folderId: string | null) => (folderId === null ? [] : folderPath(folders, folderId).map(f => f.id));

/**
 * The folders (each with its subfolders) and flows a token's run for real is held to: a workspace of the user, one of its
 * projects, its tree with a box per folder and flow. What is under a folder picked is in already (its box checked, off).
 * The picked ones, of any project, are listed under it.
 */
export function RunScopePicker({
    workspaces,
    picked,
    onChange,
}: {
    workspaces: Membership[];
    picked: PickedItem[];
    onChange: (picked: PickedItem[]) => void;
}) {
    const [workspace, setWorkspace] = useState(workspaces[0]?.handle ?? '');
    // what was loaded, with what it is of: a workspace's projects, a project's contents (another one chosen: none yet)
    const [loadedProjects, setLoadedProjects] = useState<{ workspace: string; projects: Project[] } | null>(null);
    const [chosen, setChosen] = useState<{ workspace: string; projectId: string } | null>(null);
    const [loadedContents, setLoadedContents] = useState<{ projectId: string; contents: ProjectContents } | null>(null);
    const projects = loadedProjects?.workspace === workspace ? loadedProjects.projects : [];
    const projectId = chosen?.workspace === workspace ? chosen.projectId : (projects[0]?.id ?? '');
    const contents = loadedContents?.projectId === projectId ? loadedContents.contents : null;

    useEffect(() => {
        let current = true;
        if (workspace) {
            void listProjects('active', workspace).then(result => {
                if (current && result.ok) {
                    setLoadedProjects({ workspace, projects: result.value });
                }
            });
        }
        return () => {
            current = false;
        };
    }, [workspace]);

    useEffect(() => {
        let current = true;
        if (projectId) {
            void getProjectContents(projectId, workspace).then(result => {
                if (current && result.ok) {
                    setLoadedContents({ projectId, contents: result.value });
                }
            });
        }
        return () => {
            current = false;
        };
    }, [projectId, workspace]);

    const project = projects.find(p => p.id === projectId)?.name ?? '';
    const ids = new Set(picked.map(p => p.id));
    const toggle = (kind: 'folder' | 'flow', item: Folder | Flow) =>
        onChange(
            ids.has(item.id) ? picked.filter(p => p.id !== item.id) : [...picked, pickedOf(kind, item, contents!, project, workspace)],
        );

    /** one level of the tree: its folders (open, with what is under them) and its flows */
    const level = (folderId: string | null, depth: number) => {
        if (!contents) {
            return null;
        }
        const { folders, flows } = childrenOf(contents, folderId);
        return (
            <>
                {folders.map(folder => {
                    const covered = ancestors(contents.folders, folder.parentId).some(id => ids.has(id));
                    return (
                        <li key={folder.id}>
                            <Row
                                depth={depth}
                                icon={<FolderIcon className="size-4 text-muted-foreground" />}
                                name={folder.name}
                                checked={covered || ids.has(folder.id)}
                                disabled={covered}
                                onToggle={() => toggle('folder', folder)}
                            />
                            <ul>{level(folder.id, depth + 1)}</ul>
                        </li>
                    );
                })}
                {flows.map(flow => {
                    const covered = ancestors(contents.folders, flow.folderId).some(id => ids.has(id));
                    return (
                        <li key={flow.id}>
                            <Row
                                depth={depth}
                                icon={<Workflow className="size-4 text-muted-foreground" />}
                                name={flow.name}
                                checked={covered || ids.has(flow.id)}
                                disabled={covered}
                                onToggle={() => toggle('flow', flow)}
                            />
                        </li>
                    );
                })}
            </>
        );
    };

    return (
        <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1.5">
                    <Label htmlFor="scope-workspace">Workspace</Label>
                    <select id="scope-workspace" className={SELECT} value={workspace} onChange={event => setWorkspace(event.target.value)}>
                        {workspaces.map(w => (
                            <option key={w.handle} value={w.handle}>
                                {w.name}
                            </option>
                        ))}
                    </select>
                </div>
                <div className="grid gap-1.5">
                    <Label htmlFor="scope-project">Project</Label>
                    <select
                        id="scope-project"
                        className={SELECT}
                        value={projectId}
                        onChange={event => setChosen({ workspace, projectId: event.target.value })}
                    >
                        {projects.map(p => (
                            <option key={p.id} value={p.id}>
                                {p.name}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
            <ul aria-label="Folders and flows" className="max-h-56 overflow-auto rounded-lg border py-1">
                {contents ? level(null, 0) : <li className="px-3 py-1.5 text-sm text-muted-foreground">Loading…</li>}
                {contents && childrenOf(contents, null).folders.length + childrenOf(contents, null).flows.length === 0 && (
                    <li className="px-3 py-1.5 text-sm text-muted-foreground">No folders or flows.</li>
                )}
            </ul>
            <PickedList picked={picked} onRemove={id => onChange(picked.filter(p => p.id !== id))} />
        </div>
    );
}

function Row(props: { depth: number; icon: React.ReactNode; name: string; checked: boolean; disabled: boolean; onToggle: () => void }) {
    return (
        <label
            className={cn(
                'flex cursor-pointer items-center gap-2 px-3 py-1 text-sm hover:bg-accent',
                props.disabled && 'cursor-default opacity-60',
            )}
            style={{ paddingLeft: `${0.75 + props.depth * 1.25}rem` }}
        >
            <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={props.checked}
                disabled={props.disabled}
                onChange={props.onToggle}
            />
            {props.icon}
            <span className="truncate">{props.name}</span>
        </label>
    );
}

/** the folders and flows picked, of any project, each with a button to take it out */
export function PickedList({ picked, onRemove }: { picked: PickedItem[]; onRemove?: (id: string) => void }) {
    if (picked.length === 0) {
        return null;
    }
    return (
        <ul aria-label="Picked" className="flex flex-wrap gap-1.5">
            {picked.map(item => (
                <li key={item.id} className="flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 text-xs">
                    {item.kind === 'folder' ? <FolderIcon className="size-3.5" /> : <Workflow className="size-3.5" />}
                    <span title={`${item.workspace} › ${item.project}`}>
                        {item.project} › {item.path}
                    </span>
                    {onRemove && (
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-5"
                            aria-label={`Remove ${item.path}`}
                            onClick={() => onRemove(item.id)}
                        >
                            <X />
                        </Button>
                    )}
                </li>
            ))}
        </ul>
    );
}
