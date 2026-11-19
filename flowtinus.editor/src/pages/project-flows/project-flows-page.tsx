import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { ChevronsDownUp, ChevronsUpDown, FolderPlus, GitFork, LayoutGrid, ListTree, Plus, RotateCw, TriangleAlert } from 'lucide-react';
import { ArchiveDialog } from '@/components/archive-dialog';
import { ConfirmDialog, type ConfirmTarget } from '@/components/confirm-dialog';
import { SegmentedControl } from '@/components/segmented-control';
import { StatusFilter, type ListStatus } from '@/components/status-filter';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Flow, Folder, ProjectContents } from '@/data/flows/flow';
import { anyTriggerOn, flowsTaken, folderPath, isFolderVisible, projectRepoPaths, repoPathIssue, siblingNames, triggersOn, withFlow, withFolder, type TreeContents } from '@/data/flows/project-tree';
import * as flowsApi from '@/data/flows/flows-api';
import { useProjectContents } from '@/data/flows/use-project-contents';
import { useProject } from '@/data/projects/use-project';
import type { ApiResult } from '@/lib/api';
import { useBranchOffer } from '@/layout/use-branch-offer';
import { readProjectView, saveProjectView, type ProjectView } from '@/lib/view-preference';
import { ProjectPage } from '@/pages/project/project-page';
import { ArchivedList } from './archived-list';
import { CardsView } from './cards-view';
import { GraphView } from './graph-view';
import type { ItemActions } from './item-menus';
import { MoveDialog, type MoveTarget } from './move-dialog';
import { NameDialog, type NameDialogTarget } from './name-dialog';
import { TreeView } from './tree-view';
import { TriggersWarning } from './triggers-warning';

/** the Tree / Cards choice: the last one saved in this browser shows first (view-preference.ts) */
function useView(): [ProjectView, (view: ProjectView) => void] {
    const [view, setView] = useState<ProjectView>(readProjectView);
    const change = (next: ProjectView) => {
        setView(next);
        saveProjectView(next);
    };

    return [view, change];
}

/** the folders open in Tree with `folderId` shown: the ones already open, and it and every folder above it */
export function revealFolder(expanded: Set<string>, folders: Folder[], folderId: string | null): Set<string> {
    const next = new Set(expanded);
    for (const folder of folderPath(folders, folderId)) {
        next.add(folder.id);
    }

    return next;
}

// a work branch's folder ids are its own: a folder is found by its names
async function folderOnBranch(projectId: string, names: string[]): Promise<ApiResult<string | null>> {
    if (names.length === 0) {
        return { ok: true, value: null };
    }
    const contents = await flowsApi.getProjectContents(projectId);
    if (!contents.ok) {
        return contents;
    }
    let id: string | null = null;
    for (const name of names) {
        const found = contents.value.folders.find(f => f.parentId === id && !f.archivedAt && f.name.toLowerCase() === name.toLowerCase());
        if (!found) {
            return { ok: false, error: { code: 'not-found', message: `The folder ${names.join(' / ')} is not on the new branch.` } };
        }
        id = found.id;
    }
    return { ok: true, value: id };
}

const inFolder = async (projectId: string, names: string[], change: (folderId: string | null) => Promise<ApiResult<unknown>>) => {
    const folder = await folderOnBranch(projectId, names);
    return folder.ok ? change(folder.value) : folder;
};

/**
 * A project's folders and flows (/projects/:projectId/flows), from flowtinus.server (data/flows/flows-api.ts). Tree or Cards
 * (remembered), Active or Archived (?status=archived),
 * and the folder being shown (?folder=<id>, e.g. from a breadcrumb): Cards shows its contents, Tree opens down to it.
 */
export function ProjectFlowsPage() {
    const { projectId = '', ws = '' } = useParams();
    const [params, setParams] = useSearchParams();
    const status: ListStatus = params.get('status') === 'archived' ? 'archived' : 'active';
    const [view, setView] = useView();
    const project = useProject(projectId);
    const store = useProjectContents(projectId);
    const contents: ProjectContents = store.state.status === 'ready' ? store.state.contents : { folders: [], flows: [] };

    // the folder shown in Cards; one that is gone or archived shows the root
    const requestedFolder = params.get('folder');
    const folderId = requestedFolder && isFolderVisible(contents.folders, requestedFolder) ? requestedFolder : null;
    const path = folderPath(contents.folders, folderId);

    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    // Tree opens down to the folder in the URL once, when the contents are there (then the chevrons are the user's)
    const revealed = useRef<string | null>(null);
    useEffect(() => {
        if (folderId && revealed.current !== folderId) {
            revealed.current = folderId;
            setExpanded(current => revealFolder(current, contents.folders, folderId));
        }
    }, [folderId, contents.folders]);
    const [naming, setNaming] = useState<NameDialogTarget | null>(null);
    const [moving, setMoving] = useState<MoveTarget | null>(null);
    const [archiving, setArchiving] = useState<{ kind: 'folder' | 'flow'; id: string; name: string } | null>(null);
    const [deleting, setDeleting] = useState<ConfirmTarget | null>(null);
    /** a failed restore (e.g. the name is taken where it goes back) */
    const [notice, setNotice] = useState('');
    const branchOffer = useBranchOffer();
    const namesOf = (folderId: string | null) => folderPath(contents.folders, folderId).map(f => f.name);

    const changeParams = (changes: Record<string, string | null>) => {
        const next = new URLSearchParams(params);
        for (const [key, value] of Object.entries(changes)) {
            if (value === null) {
                next.delete(key);
            } else {
                next.set(key, value);
            }
        }

        setParams(next);
    };

    /** "In Imports / Daily" for the dialogs */
    const describe = (parentId: string | null) => {
        const where = folderPath(contents.folders, parentId)
            .map(f => f.name)
            .join(' / ');
        return where ? `In ${where}` : 'At the project root';
    };

    const allFolderIds = () => new Set(contents.folders.map(f => f.id));

    const pathIssue = (change: (name: string) => TreeContents) => (name: string) =>
        project.status === 'ready' ? repoPathIssue(projectRepoPaths(ws, project.project.name, change(name))) : undefined;

    const actions: ItemActions = {
        openFolder: id => changeParams({ folder: id }),
        newFolder: parentId =>
            setNaming({
                title: 'New folder',
                description: describe(parentId),
                initial: '',
                submitLabel: 'Create',
                kind: 'folder',
                siblings: siblingNames(contents, 'folder', parentId),
                pathIssue: pathIssue(name => withFolder(contents, { id: '', parentId, name })),
                onSave: async name => {
                    const result = await branchOffer.orOffer(
                        name,
                        () => store.createFolder(parentId, name),
                        () => inFolder(projectId, namesOf(parentId), parent => flowsApi.createFolder(projectId, parent, name)),
                    );
                    if (result.ok && parentId) {
                        setExpanded(current => new Set(current).add(parentId));
                    }

                    return result;
                },
            }),
        newFlow: folder =>
            setNaming({
                title: 'New flow',
                description: describe(folder),
                initial: '',
                submitLabel: 'Create',
                kind: 'flow',
                siblings: siblingNames(contents, 'flow', folder),
                pathIssue: pathIssue(name => withFlow(contents, { id: '', folderId: folder, name })),
                onSave: async name => {
                    const result = await branchOffer.orOffer(
                        name,
                        () => store.createFlow(folder, name),
                        () => inFolder(projectId, namesOf(folder), parent => flowsApi.createFlow(projectId, { name, folderId: parent })),
                    );
                    if (result.ok && folder) {
                        setExpanded(current => new Set(current).add(folder));
                    }

                    return result;
                },
            }),
        rename: (kind, item) => {
            const parentId = kind === 'folder' ? (item as Folder).parentId : (item as Flow).folderId;
            setNaming({
                title: kind === 'folder' ? 'Rename folder' : 'Rename flow',
                initial: item.name,
                submitLabel: 'Save',
                kind,
                siblings: siblingNames(contents, kind, parentId, item.id),
                pathIssue: pathIssue(name =>
                    kind === 'folder'
                        ? withFolder(contents, { id: item.id, parentId, name })
                        : withFlow(contents, { id: item.id, folderId: parentId, name }),
                ),
                onSave: name =>
                    kind === 'folder'
                        ? branchOffer.orOffer(
                              item.name,
                              () => store.renameFolder(item.id, name),
                              () => inFolder(projectId, namesOf(item.id), id => flowsApi.renameFolder(id!, name)),
                          )
                        : branchOffer.orOffer(
                              item.name,
                              () => store.renameFlow(item.id, name),
                              () => flowsApi.renameFlow(item.id, name),
                          ),
            });
        },
        move: (kind, item) =>
            setMoving({
                kind,
                id: item.id,
                name: item.name,
                currentFolderId: kind === 'folder' ? (item as Folder).parentId : (item as Flow).folderId,
            }),
        clone: flow => {
            const siblings = siblingNames(contents, 'flow', flow.folderId);
            const taken = (name: string) => siblings.some(s => s.name.toLowerCase() === name.toLowerCase());
            let initial = `${flow.name} (copy)`;
            for (let n = 2; taken(initial); n++) {
                initial = `${flow.name} (copy ${n})`;
            }
            setNaming({
                title: 'Clone flow',
                description: `A copy of ${flow.name}. ${describe(flow.folderId)}`,
                initial,
                submitLabel: 'Clone',
                kind: 'flow',
                siblings,
                pathIssue: pathIssue(name => withFlow(contents, { id: '', folderId: flow.folderId, name })),
                onSave: name =>
                    branchOffer.orOffer(
                        flow.name,
                        () => store.cloneFlow(flow.id, name),
                        () => flowsApi.cloneFlow(flow.id, name),
                    ),
            });
        },
        archive: (kind, item) => setArchiving({ kind, id: item.id, name: item.name }),
    };

    const move = (target: MoveTarget, to: string | null): Promise<ApiResult<unknown>> =>
        branchOffer.orOffer<unknown>(
            target.name,
            () => (target.kind === 'folder' ? store.moveFolder(target.id, to) : store.moveFlow(target.id, to)),
            () =>
                inFolder(projectId, namesOf(to), folderId =>
                    target.kind === 'folder'
                        ? inFolder(projectId, namesOf(target.id), id => flowsApi.moveFolder(id!, folderId))
                        : flowsApi.moveFlow(target.id, folderId),
                ),
        );

    const restore = async (kind: 'folder' | 'flow', id: string) => {
        setNotice('');
        const result = kind === 'folder' ? await store.restoreFolder(id) : await store.restoreFlow(id);
        if (!result.ok) {
            setNotice(result.error.message);
        }
    };

    /** "Delete <name>?": for good; a folder takes the flows under it; what is still on is turned off */
    const askDelete = (kind: 'folder' | 'flow', item: { id: string; name: string }) => {
        const flows = flowsTaken(contents, kind, item.id, true);
        const on = triggersOn(flows);
        const count = flows.length === 1 ? '1 flow' : `${flows.length} flows`;
        setNotice('');
        setDeleting({
            title: kind === 'folder' ? `Delete folder ${item.name}?` : `Delete flow ${item.name}?`,
            description:
                kind === 'folder'
                    ? `The folder, its subfolders and the ${count} in it are deleted too. This cannot be undone.`
                    : 'It is deleted for good: it leaves Archived and cannot be restored. Its runs stay in history.',
            warning: anyTriggerOn(on) ? <TriggersWarning on={on} /> : undefined,
            confirmLabel: 'Delete',
            busyLabel: 'Deleting...',
            destructive: true,
            onConfirm: () => (kind === 'folder' ? store.deleteFolder(item.id) : store.deleteFlow(item.id)),
        });
    };

    // what archiving takes: the flow, or the folder's active flows (at any depth); the deploys, schedules, webhooks on
    const archivingFlows = archiving ? flowsTaken(contents, archiving.kind, archiving.id, false) : [];
    const archivingOn = triggersOn(archivingFlows);

    const toggle = (id: string) =>
        setExpanded(current => {
            const next = new Set(current);
            if (!next.delete(id)) {
                next.add(id);
            }

            return next;
        });

    // where New folder / New flow put things: the folder shown in Cards; the root in Tree (folders have "... > New ... here")
    const createIn = view === 'cards' ? folderId : null;

    return (
        <ProjectPage
            projectId={projectId}
            project={project}
            tab="flows"
            folders={view === 'cards' && status === 'active' ? path : []}
            actions={
                status === 'active' && (
                    <>
                        <Button variant="outline" onClick={() => actions.newFolder(createIn)}>
                            <FolderPlus /> New folder
                        </Button>
                        <Button onClick={() => actions.newFlow(createIn)}>
                            <Plus /> New flow
                        </Button>
                    </>
                )
            }
        >
            <StatusFilter
                value={status}
                onChange={value => changeParams({ status: value === 'archived' ? 'archived' : null })}
                idPrefix="flows"
            />

            {/* the view on the left, always in the same place; Expand / Collapse (Tree only) on the right */}
            {status === 'active' && (
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <SegmentedControl
                        label="View"
                        value={view}
                        onChange={setView}
                        options={[
                            { value: 'tree', label: 'Tree', icon: ListTree },
                            { value: 'cards', label: 'Cards', icon: LayoutGrid },
                            { value: 'graph', label: 'Graph', icon: GitFork },
                        ]}
                    />
                    {view === 'tree' && (
                        <div className="flex items-center gap-1">
                            <Button variant="ghost" size="sm" onClick={() => setExpanded(allFolderIds())}>
                                <ChevronsUpDown /> Expand all
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setExpanded(new Set())}>
                                <ChevronsDownUp /> Collapse all
                            </Button>
                        </div>
                    )}
                </div>
            )}

            {notice && <p className="text-sm text-destructive">{notice}</p>}

            {store.state.status === 'loading' && (
                <div className="grid gap-2" aria-busy="true">
                    {[0, 1, 2].map(i => (
                        <Skeleton key={i} className="h-12 rounded-lg" />
                    ))}
                </div>
            )}

            {store.state.status === 'error' && (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-12 text-center">
                    <TriangleAlert className="size-8 text-destructive" />
                    <p className="text-sm text-muted-foreground">{store.state.error.message}</p>
                    <Button variant="outline" onClick={() => void store.reload()}>
                        <RotateCw /> Try again
                    </Button>
                </div>
            )}

            {store.state.status === 'ready' && status === 'archived' && (
                <ArchivedList contents={contents} onRestore={(kind, id) => void restore(kind, id)} onDelete={askDelete} />
            )}
            {store.state.status === 'ready' && status === 'active' && view === 'cards' && (
                <CardsView contents={contents} projectId={projectId} folderId={folderId} actions={actions} />
            )}
            {store.state.status === 'ready' && status === 'active' && view === 'tree' && (
                <TreeView
                    contents={contents}
                    projectId={projectId}
                    expanded={expanded}
                    onToggle={toggle}
                    actions={actions}
                    current={folderId}
                />
            )}
            {store.state.status === 'ready' && status === 'active' && view === 'graph' && <GraphView projectId={projectId} />}

            <NameDialog target={naming} onClose={() => setNaming(null)} />
            <MoveDialog target={moving} contents={contents} onClose={() => setMoving(null)} onMove={move} />
            <ArchiveDialog
                name={archiving ? (archiving.kind === 'folder' ? `folder ${archiving.name}` : archiving.name) : null}
                description={
                    archiving?.kind === 'folder'
                        ? `The folder, its subfolders and the ${archivingFlows.length === 1 ? '1 flow' : `${archivingFlows.length} flows`} in it move to Archived. Restoring the folder brings them back.`
                        : undefined
                }
                warning={anyTriggerOn(archivingOn) ? <TriggersWarning on={archivingOn} /> : undefined}
                onClose={() => setArchiving(null)}
                onArchive={() => {
                    const { kind, id, name } = archiving!;
                    return kind === 'folder'
                        ? branchOffer.orOffer(
                              name,
                              () => store.archiveFolder(id),
                              () => inFolder(projectId, namesOf(id), found => flowsApi.archiveFolder(found!)),
                          )
                        : branchOffer.orOffer(
                              name,
                              () => store.archiveFlow(id),
                              () => flowsApi.archiveFlow(id),
                          );
                }}
            />
            {branchOffer.dialog}
            <ConfirmDialog target={deleting} onClose={() => setDeleting(null)} />
        </ProjectPage>
    );
}
