import { useState } from 'react';
import { ExternalLink, File, Folder } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { closePr, mergePr, prStatus, server } from './actions';
import { applyOverlay, commitsBetween, type Tree } from './model';
import { useStore } from './store';
import { BASE, ChangeLabel, DiffView, Pill, prRoute, Sha, when } from './ui';

function ProviderFrame({ children }: { children: React.ReactNode }) {
    return (
        <div className="-m-6 min-h-full bg-orange-50/40 p-6 dark:bg-orange-950/10">
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm text-white">
                <ExternalLink className="size-4" /> gitlab.example.com / omc-solutions / flows
                <span className="ml-auto rounded bg-white/20 px-2 text-xs">MOCK PROVIDER: outside Flowtinus</span>
            </div>
            {children}
        </div>
    );
}

export function ProviderPage() {
    const { state } = useStore();
    return (
        <ProviderFrame>
            <h1 className="mb-3 text-xl font-semibold">Merge requests</h1>
            <div className="grid gap-2">
                {state.prs
                    .slice()
                    .reverse()
                    .map(p => (
                        <Link
                            key={p.number}
                            to={prRoute(p.number)}
                            className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm hover:bg-muted"
                        >
                            <span className="font-mono">!{p.number}</span>
                            <Pill tone={p.state === 'open' ? 'info' : p.state === 'merged' ? 'ok' : 'muted'}>{p.state}</Pill>
                            <span className="truncate">{p.title}</span>
                            <span className="ml-auto font-mono text-xs text-muted-foreground">
                                {p.from} → {p.to}
                            </span>
                        </Link>
                    ))}
            </div>
        </ProviderFrame>
    );
}

export function PrPage() {
    const { state, act } = useStore();
    const { number = '' } = useParams();
    const pr = state.prs.find(p => p.number === Number(number));
    const [method, setMethod] = useState<'merge' | 'ff' | 'squash'>('merge');
    const [error, setError] = useState('');
    const [open, setOpen] = useState<string | null>(null);
    if (!pr) {
        return <ProviderFrame>No such merge request.</ProviderFrame>;
    }
    const status = prStatus(state, pr);
    return (
        <ProviderFrame>
            <div className="grid max-w-4xl gap-4">
                <div>
                    <h1 className="text-xl font-semibold">
                        {pr.title} <span className="font-normal text-muted-foreground">!{pr.number}</span>
                    </h1>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                        <Pill tone={pr.state === 'open' ? 'info' : pr.state === 'merged' ? 'ok' : 'muted'}>{pr.state}</Pill>
                        <Pill>{pr.kind}</Pill>
                        <span className="font-mono">{pr.from}</span> → <span className="font-mono">{pr.to}</span>
                        <span className="text-muted-foreground">
                            by {pr.author}, opened from the {pr.openedOn} server
                        </span>
                        {pr.mergeSha && (
                            <span>
                                merged as <Sha sha={pr.mergeSha} />
                            </span>
                        )}
                    </div>
                </div>
                {pr.state === 'open' && (
                    <>
                        <section className="grid gap-1 rounded-lg border bg-background p-3">
                            <h2 className="text-sm font-semibold">Commits ({status.commits.length})</h2>
                            {status.commits.map(c => (
                                <div key={c.sha} className="flex gap-2 text-sm">
                                    <Sha sha={c.sha} /> <span className="truncate">{c.message}</span>
                                    <span className="ml-auto text-xs text-muted-foreground">
                                        {c.author}, {when(c.at)}
                                    </span>
                                </div>
                            ))}
                            {pr.from === 'dev' || pr.from === 'staging' || pr.from === 'prod' ? (
                                <p className="text-xs text-amber-700 dark:text-amber-400">
                                    This MR is from {pr.from} itself: it follows the branch, so commits that land on {pr.from} after it was
                                    opened join it.
                                </p>
                            ) : null}
                        </section>
                        <section className="grid gap-1 rounded-lg border bg-background p-3">
                            <h2 className="text-sm font-semibold">Changes ({status.files.length})</h2>
                            {status.files.map(f => (
                                <div key={f.key}>
                                    <button
                                        type="button"
                                        className="w-full text-left"
                                        onClick={() => setOpen(open === f.key ? null : f.key)}
                                    >
                                        <ChangeLabel change={f} />
                                    </button>
                                    {open === f.key && <DiffView className="my-1" before={f.before ?? ''} after={f.after ?? ''} />}
                                </div>
                            ))}
                        </section>
                        {status.conflicts.length > 0 && (
                            <p className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-sm">
                                Merge blocked: conflicts in {status.conflicts.join(', ')}.{' '}
                                {pr.kind === 'change'
                                    ? 'Update the source branch in Flowtinus first.'
                                    : `The source is an environment's branch: Update would pull ${pr.to} into ${pr.from}, which the design does not allow. No resolution path in the design (prototype finding).`}
                            </p>
                        )}
                        <section className="grid gap-2 rounded-lg border bg-background p-3">
                            <h2 className="text-sm font-semibold">Merge method</h2>
                            {(
                                [
                                    ['merge', 'Merge commit'],
                                    ['ff', 'Fast-forward'],
                                    ['squash', 'Squash'],
                                ] as const
                            ).map(([key, label]) => {
                                const disabled = (key === 'ff' && !status.canFf) || (key === 'squash' && pr.kind !== 'change');
                                return (
                                    <label key={key} className={cn('flex items-center gap-2 text-sm', disabled && 'opacity-50')}>
                                        <input
                                            type="radio"
                                            name="method"
                                            disabled={disabled}
                                            checked={method === key}
                                            onChange={() => setMethod(key)}
                                        />
                                        {label}
                                        {key === 'squash' && pr.kind !== 'change' && (
                                            <span className="text-xs">(never for a promotion or backport: it breaks ancestry)</span>
                                        )}
                                        {key === 'ff' && !status.canFf && <span className="text-xs">(the target moved)</span>}
                                    </label>
                                );
                            })}
                            {error && <p className="text-sm text-destructive">{error}</p>}
                            <div className="flex gap-2">
                                <Button
                                    className="bg-emerald-600 hover:bg-emerald-700"
                                    disabled={status.conflicts.length > 0 || status.commits.length === 0}
                                    onClick={() => setError(act(d => mergePr(d, pr.number, method)) ?? '')}
                                >
                                    Merge (fake: as if a reviewer merged it here)
                                </Button>
                                <Button variant="outline" onClick={() => act(d => closePr(d, pr.number))}>
                                    Close
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Merging moves {pr.to}: the server whose branch it is fetches (poll or webhook) and reconciles: that is the
                                deploy.
                            </p>
                        </section>
                    </>
                )}
                <Link to={`${BASE}/environments`} className="text-sm text-primary underline">
                    Back to Flowtinus (Environments)
                </Link>
            </div>
        </ProviderFrame>
    );
}

type Dir = { dirs: Map<string, Dir>; files: string[] };

function buildTree(tree: Tree): Dir {
    const root: Dir = { dirs: new Map(), files: [] };
    for (const path of Object.keys(tree).sort()) {
        const parts = path.split('/');
        let dir = root;
        for (const part of parts.slice(0, -1)) {
            if (!dir.dirs.has(part)) {
                dir.dirs.set(part, { dirs: new Map(), files: [] });
            }
            dir = dir.dirs.get(part)!;
        }
        dir.files.push(path);
    }
    return root;
}

export function RepoPage() {
    const { state } = useStore();
    const s = server(state);
    const branches = Object.keys(state.branches).sort();
    const [branch, setBranch] = useState(s.settings.branch);
    const [withWorking, setWithWorking] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    const sha = state.branches[branch];
    const committed = sha ? state.commits[sha]!.tree : {};
    const tree = withWorking ? applyOverlay(committed, s.working[branch]) : committed;
    const root = buildTree(tree);
    const log = commitsBetween(state, undefined, sha).slice(0, 12);

    const renderDir = (dir: Dir, name: string, depth: number): React.ReactNode => (
        <div key={name + depth} style={{ paddingLeft: depth ? 14 : 0 }}>
            {name && (
                <div className="flex items-center gap-1 py-0.5 text-sm">
                    <Folder className="size-3.5 text-muted-foreground" /> {name}/
                </div>
            )}
            {[...dir.dirs].map(([n, d]) => renderDir(d, n, depth + 1))}
            {dir.files.map(path => (
                <button
                    key={path}
                    type="button"
                    style={{ paddingLeft: 14 }}
                    className={cn(
                        'flex w-full items-center gap-1 py-0.5 text-left text-sm hover:bg-muted',
                        selected === path && 'bg-muted font-medium',
                    )}
                    onClick={() => setSelected(path)}
                >
                    <File className="size-3.5 text-muted-foreground" /> {path.split('/').pop()}
                    {committed[path] !== tree[path] && <Pill tone="warn">uncommitted</Pill>}
                </button>
            ))}
        </div>
    );

    return (
        <div className="grid gap-4">
            <h1 className="text-2xl font-semibold">Repository</h1>
            <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                    Branch
                    <select
                        className="h-8 rounded-md border bg-background px-2 font-mono text-sm"
                        value={branch}
                        onChange={e => setBranch(e.target.value)}
                    >
                        {branches.map(b => (
                            <option key={b}>{b}</option>
                        ))}
                    </select>
                </label>
                <Sha sha={sha} />
                <label className="flex items-center gap-2">
                    <Switch checked={withWorking} onCheckedChange={setWithWorking} /> with {s.env}'s working copy of it
                </label>
            </div>
            <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
                <div className="rounded-lg border p-2 font-mono">{renderDir(root, '', 0)}</div>
                <div className="grid content-start gap-4">
                    {selected && tree[selected] !== undefined ? (
                        <div className="grid gap-1">
                            <span className="font-mono text-xs">{selected}</span>
                            <pre className="max-h-[28rem] overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
                                {tree[selected] || '(empty)'}
                            </pre>
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">Choose a file.</p>
                    )}
                    <div className="grid gap-1">
                        <h2 className="text-sm font-semibold">History of {branch}</h2>
                        {log.map(c => (
                            <div key={c.sha} className="flex gap-2 text-xs">
                                <Sha sha={c.sha} /> <Pill>{c.kind}</Pill> <span className="truncate">{c.message}</span>
                                <span className="ml-auto text-muted-foreground">{c.author}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
