import { useState } from 'react';
import { ChevronRight, FileCode, Folder, FolderPlus, Pencil, Plus, Workflow } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { createFlow, createFolder, createProject, createScript, editFiles, editRefusal, renameFlow, renameFolder, renameProject, renameScript, server, workingTree } from './actions';
import { parseWorkspace, shortHash, type FlowItem } from './model';
import { useStore } from './store';
import { Banner, flowRoute, NameDialog, Pill, projectRoute } from './ui';

type Prompt = {
    title: string;
    label: string;
    initial?: string;
    confirm: string;
    description?: string;
    run: (value: string) => string | null;
};

function usePrompt() {
    const [prompt, setPrompt] = useState<Prompt | null>(null);
    const dialog = (
        <NameDialog
            open={!!prompt}
            title={prompt?.title ?? ''}
            label={prompt?.label ?? ''}
            initial={prompt?.initial ?? ''}
            confirm={prompt?.confirm ?? 'OK'}
            description={
                prompt?.description ??
                'Names become file and folder names in git: \\ / : * ? " < > |, a trailing dot or space and Windows reserved names (CON, NUL, COM1...) are refused.'
            }
            onClose={() => setPrompt(null)}
            onSubmit={value => prompt?.run(value) ?? null}
        />
    );
    return { ask: setPrompt, dialog };
}

export function FlowStatus({ flow }: { flow: FlowItem }) {
    const { state } = useStore();
    const s = server(state);
    const row = s.flows[flow.id];
    if (!s.gitOn) {
        return row?.current ? <Pill tone="ok">v{row.current}</Pill> : <Pill>Not deployed</Pill>;
    }
    if (!row) {
        return <Pill title={`Not on ${s.settings.branch}: nothing in ${s.env} yet`}>not in {s.env}</Pill>;
    }
    if (row.current === null) {
        return (
            <Pill tone="warn" title="deployed: false in the flow file (or gone from git)">
                not running
            </Pill>
        );
    }
    return (
        <Pill tone="ok" title={`v${row.current} runs in ${s.env}`}>
            v{row.current} in {s.env}
        </Pill>
    );
}

function EditRefusal() {
    const { state } = useStore();
    const refusal = server(state).gitOn ? editRefusal(state) : null;
    return refusal ? <Banner tone="bad">{refusal}</Banner> : null;
}

export function ProjectsPage() {
    const { state, act } = useStore();
    const view = parseWorkspace(workingTree(state));
    const { ask, dialog } = usePrompt();
    return (
        <div className="grid gap-4">
            <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold">Projects</h1>
                <Button
                    className="ml-auto"
                    onClick={() => ask({ title: 'New project', label: 'Name', confirm: 'Create', run: v => act(d => createProject(d, v)) })}
                >
                    <Plus /> New project
                </Button>
            </div>
            <EditRefusal />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {view.projects.map(p => {
                    const flows = view.flows.filter(f => f.project === p.name);
                    return (
                        <Card key={p.name}>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <Link to={projectRoute(p.name)} className="hover:underline">
                                        {p.name}
                                    </Link>
                                    <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        aria-label={`Rename ${p.name}`}
                                        onClick={() =>
                                            ask({
                                                title: `Rename ${p.name}`,
                                                label: 'Name',
                                                initial: p.name,
                                                confirm: 'Rename',
                                                run: v => act(d => renameProject(d, p.name, v)),
                                            })
                                        }
                                    >
                                        <Pencil />
                                    </Button>
                                </CardTitle>
                                <CardDescription>{p.meta.description || 'No description'}</CardDescription>
                            </CardHeader>
                            <CardContent className="grid gap-1 text-sm">
                                {flows.map(f => (
                                    <Link key={f.id} to={flowRoute(f.id)} className="flex items-center gap-2 hover:underline">
                                        <Workflow className="size-4 text-muted-foreground" />
                                        <span className="truncate">
                                            {f.folder ? `${f.folder}/` : ''}
                                            {f.name}
                                        </span>
                                        <span className="ml-auto">
                                            <FlowStatus flow={f} />
                                        </span>
                                    </Link>
                                ))}
                            </CardContent>
                        </Card>
                    );
                })}
            </div>
            {dialog}
        </div>
    );
}

export function ProjectPage() {
    const { state, act } = useStore();
    const { project = '' } = useParams();
    const [params, setParams] = useSearchParams();
    const tab = params.get('tab') === 'scripts' ? 'scripts' : 'flows';
    const view = parseWorkspace(workingTree(state));
    const p = view.projects.find(x => x.name === project);
    const { ask, dialog } = usePrompt();
    if (!p) {
        return <p className="text-sm text-muted-foreground">Project "{project}" is not on this branch (renamed or not there).</p>;
    }
    const flows = view.flows.filter(f => f.project === project);

    const folderRow = (folder: string): React.ReactNode => {
        const depth = folder ? folder.split('/').length : 0;
        const subfolders = p.folders.filter(f => f.split('/').length === depth + 1 && (folder ? f.startsWith(`${folder}/`) : true));
        return (
            <div key={folder || '(root)'} className={cn(folder && 'ml-5 border-l pl-3')}>
                {folder && (
                    <div className="flex items-center gap-2 py-1 text-sm">
                        <Folder className="size-4 text-muted-foreground" />
                        <span className="font-medium">{folder.split('/').pop()}</span>
                        <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Rename ${folder}`}
                            onClick={() =>
                                ask({
                                    title: `Rename folder ${folder}`,
                                    label: 'Name',
                                    initial: folder.split('/').pop()!,
                                    confirm: 'Rename',
                                    run: v => act(d => renameFolder(d, project, folder, v)),
                                })
                            }
                        >
                            <Pencil />
                        </Button>
                        <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                                ask({
                                    title: `New flow in ${folder}`,
                                    label: 'Name',
                                    confirm: 'Create',
                                    run: v => act(d => createFlow(d, project, folder, v)),
                                })
                            }
                        >
                            <Plus /> Flow
                        </Button>
                        <Button
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                                ask({
                                    title: `New folder in ${folder}`,
                                    label: 'Name',
                                    confirm: 'Create',
                                    run: v => act(d => createFolder(d, project, folder, v)),
                                })
                            }
                        >
                            <FolderPlus /> Folder
                        </Button>
                    </div>
                )}
                {subfolders.map(folderRow)}
                {flows
                    .filter(f => f.folder === folder)
                    .map(f => (
                        <div key={f.id} className={cn('flex items-center gap-2 py-1 text-sm', folder && 'ml-5')}>
                            <Workflow className="size-4 text-muted-foreground" />
                            <Link to={flowRoute(f.id)} className="hover:underline">
                                {f.name}
                            </Link>
                            <FlowStatus flow={f} />
                            <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`Rename ${f.name}`}
                                onClick={() =>
                                    ask({
                                        title: `Rename ${f.name}`,
                                        label: 'Name',
                                        initial: f.name,
                                        confirm: 'Rename',
                                        run: v => act(d => renameFlow(d, f.id, v)),
                                    })
                                }
                            >
                                <Pencil />
                            </Button>
                        </div>
                    ))}
            </div>
        );
    };

    return (
        <div className="grid gap-4">
            <nav className="flex items-center gap-2 text-sm text-muted-foreground">
                <Link to="..">Acme</Link> <ChevronRight className="size-4" /> <span className="text-foreground">{project}</span>
            </nav>
            <div className="flex items-center gap-2">
                {(['flows', 'scripts'] as const).map(t => (
                    <Button
                        key={t}
                        variant={tab === t ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => setParams(x => (x.set('tab', t), x))}
                    >
                        {t === 'flows' ? 'Flows' : 'Scripts'}
                    </Button>
                ))}
                <div className="ml-auto flex gap-2">
                    {tab === 'flows' ? (
                        <>
                            <Button
                                variant="outline"
                                onClick={() =>
                                    ask({
                                        title: 'New folder',
                                        label: 'Name',
                                        confirm: 'Create',
                                        run: v => act(d => createFolder(d, project, '', v)),
                                    })
                                }
                            >
                                <FolderPlus /> New folder
                            </Button>
                            <Button
                                onClick={() =>
                                    ask({
                                        title: 'New flow',
                                        label: 'Name',
                                        confirm: 'Create',
                                        run: v => act(d => createFlow(d, project, '', v)),
                                    })
                                }
                            >
                                <Plus /> New flow
                            </Button>
                        </>
                    ) : (
                        <Button
                            onClick={() =>
                                ask({
                                    title: 'New script',
                                    label: 'Path (folders with /)',
                                    confirm: 'Create',
                                    description: 'A script path is folders and a file name: each part follows the file-name rules.',
                                    run: v => act(d => createScript(d, project, v)),
                                })
                            }
                        >
                            <Plus /> New script
                        </Button>
                    )}
                </div>
            </div>
            <EditRefusal />
            {tab === 'flows' ? <div className="rounded-lg border p-3">{folderRow('')}</div> : <Scripts project={project} ask={ask} />}
            {dialog}
        </div>
    );
}

function Scripts({ project, ask }: { project: string; ask: (p: Prompt) => void }) {
    const { state, act } = useStore();
    const s = server(state);
    const scripts = parseWorkspace(workingTree(state)).scripts.filter(x => x.project === project);
    const [selected, setSelected] = useState<string | null>(scripts[0]?.rel ?? null);
    const script = scripts.find(x => x.rel === selected);
    const deployedHash = script ? s.scripts[script.path] : undefined;
    const readOnly = s.gitOn && editRefusal(state) !== null;
    return (
        <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
            <ul className="grid content-start gap-1 rounded-lg border p-2">
                {scripts.map(x => (
                    <li key={x.rel} className="flex items-center gap-1">
                        <button
                            type="button"
                            className={cn(
                                'flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted',
                                x.rel === selected && 'bg-muted font-medium',
                            )}
                            onClick={() => setSelected(x.rel)}
                        >
                            <FileCode className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate font-mono text-xs">{x.rel}</span>
                        </button>
                        <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Rename ${x.rel}`}
                            onClick={() =>
                                ask({
                                    title: `Rename ${x.rel}`,
                                    label: 'Path',
                                    initial: x.rel,
                                    confirm: 'Rename',
                                    description:
                                        'Flows call scripts by path: the flows that call it are rewritten too, so they show as changes.',
                                    run: v => {
                                        const problem = act(d => renameScript(d, project, x.rel, v));
                                        if (!problem) {
                                            setSelected(v);
                                        }
                                        return problem;
                                    },
                                })
                            }
                        >
                            <Pencil />
                        </Button>
                    </li>
                ))}
            </ul>
            {script && (
                <div className="grid content-start gap-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-mono">{script.rel}</span>
                        {s.gitOn &&
                            (deployedHash === undefined ? (
                                <Pill>not in {s.env}'s deployed set</Pill>
                            ) : deployedHash === shortHash(script.content) ? (
                                <Pill tone="ok">same as {s.env}'s deployed set (what triggers run)</Pill>
                            ) : (
                                <Pill tone="warn">differs from {s.env}'s deployed set: Run uses this, triggers use the deployed one</Pill>
                            ))}
                    </div>
                    <Textarea
                        className="min-h-64 font-mono text-xs"
                        value={script.content}
                        readOnly={readOnly}
                        onChange={e => act(d => editFiles(d, { [script.path]: e.target.value }, `Script ${script.rel} edited`, true))}
                    />
                </div>
            )}
        </div>
    );
}
