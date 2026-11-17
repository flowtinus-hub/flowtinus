import { useState } from 'react';
import { CircleCheck, CircleX, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createConnection, saveLocalSettings, saveTopology, server, testAccess, turnGitOff, turnGitOn, workingTree, type TurnOn } from './actions';
import { CONFIG_BRANCH, parseWorkspace, topology, topologyProblems, type EnvDecl, type GitSettings, type Mode } from './model';
import { useStore } from './store';
import { Banner, NameDialog, Pill } from './ui';

export function SettingsPage() {
    const { state, act } = useStore();
    const s = server(state);
    const [draft, setDraft] = useState<{ env: string; settings: GitSettings } | null>(null);
    const [test, setTest] = useState<{ ok: boolean; lines: string[] } | null>(null);
    const [turnOn, setTurnOn] = useState<TurnOn | null>(null);
    const settings = draft?.env === s.env ? draft.settings : s.settings;
    const setGit = (patch: Partial<GitSettings>) => setDraft({ env: s.env, settings: { ...settings, ...patch } });
    const envs = topology(state);

    const tryOn = (opts: Parameters<typeof turnGitOn>[2] = {}) => {
        const result = act(d => turnGitOn(d, s.env, opts));
        setTurnOn(result.error || result.needs ? result : null);
    };

    return (
        <div className="mx-auto grid w-full max-w-4xl gap-8">
            <h1 className="text-2xl font-semibold">Settings</h1>
            <section className="grid gap-4">
                <div className="flex items-center gap-3">
                    <h2 className="text-lg font-semibold">This server</h2>
                    <Pill tone="info">{s.env}</Pill>
                    {s.gitOn ? <Pill tone="ok">git on</Pill> : <Pill>git off</Pill>}
                </div>
                <Banner tone="info">
                    A server keeps only the repository, the token's secret and which environment it is (the{' '}
                    <span className="font-mono">git</span> key in its workspace_settings). Its branch, mode and targets come from the
                    topology, below.
                </Banner>
                <div className="grid gap-4 rounded-lg border p-4">
                    <div className="grid gap-2">
                        <Label htmlFor="repo">Repository URL (HTTP(S); SSH later)</Label>
                        <Input id="repo" value={settings.repo} onChange={e => setGit({ repo: e.target.value })} />
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                        <div className="grid gap-2">
                            <Label htmlFor="credential">Token (a workspace secret)</Label>
                            <select
                                id="credential"
                                className="h-9 rounded-md border bg-background px-2 text-sm"
                                value={settings.credential}
                                onChange={e => setGit({ credential: e.target.value })}
                            >
                                <option value="">(none)</option>
                                {state.secrets.map(secret => (
                                    <option key={secret} value={secret}>
                                        {secret}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="env">This server is</Label>
                            <select
                                id="env"
                                className="h-9 rounded-md border bg-background px-2 text-sm"
                                value={settings.env}
                                onChange={e => setGit({ env: e.target.value })}
                            >
                                {[...new Set([settings.env, ...envs.map(e => e.env)])].map(env => (
                                    <option key={env} value={env}>
                                        {env}
                                        {envs.find(e => e.env === env)
                                            ? ` (${envs.find(e => e.env === env)!.branch})`
                                            : ' (not in the topology)'}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={() => setTest(testAccess(state, s.env, settings))}>
                            Test access
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => {
                                act(d => saveLocalSettings(d, s.env, settings));
                                setDraft(null);
                            }}
                        >
                            Save
                        </Button>
                        {s.gitOn ? (
                            <Button variant="outline" onClick={() => act(d => turnGitOff(d, s.env))}>
                                Turn git off
                            </Button>
                        ) : (
                            <Button onClick={() => tryOn()}>Turn git on</Button>
                        )}
                    </div>
                    {test && (
                        <div className="grid gap-1 rounded-md border p-3 text-sm">
                            <div className="flex items-center gap-2 font-medium">
                                {test.ok ? (
                                    <CircleCheck className="size-4 text-emerald-600" />
                                ) : (
                                    <CircleX className="size-4 text-red-600" />
                                )}
                                {test.ok ? 'Access works' : 'Access has a problem'}
                            </div>
                            {test.lines.map(line => (
                                <p key={line} className="text-muted-foreground">
                                    {line}
                                </p>
                            ))}
                        </div>
                    )}
                    {turnOn?.error && <Banner tone="bad">{turnOn.error}</Banner>}
                    {turnOn?.needs === 'branch' && (
                        <Banner tone="warn" className="grid gap-2">
                            {turnOn.lines?.map(line => (
                                <span key={line}>{line}</span>
                            ))}
                            <span className="flex gap-2">
                                <Button size="xs" onClick={() => tryOn({ createBranch: true })}>
                                    Create it and turn git on
                                </Button>
                                <Button size="xs" variant="outline" onClick={() => setTurnOn(null)}>
                                    Cancel
                                </Button>
                            </span>
                        </Banner>
                    )}
                    {turnOn?.needs === 'choice' && (
                        <Banner tone="warn" className="grid gap-2">
                            <span>Both git and {s.env} have this workspace. Choose which one wins:</span>
                            {turnOn.lines?.map(line => (
                                <span key={line}>· {line}</span>
                            ))}
                            <span className="flex gap-2">
                                <Button size="xs" onClick={() => tryOn({ choice: 'git' })}>
                                    Git replaces {s.env}
                                </Button>
                                <Button size="xs" variant="outline" onClick={() => tryOn({ choice: 'server' })}>
                                    {s.env} replaces git
                                </Button>
                                <Button size="xs" variant="ghost" onClick={() => setTurnOn(null)}>
                                    Cancel
                                </Button>
                            </span>
                        </Banner>
                    )}
                    <p className="text-xs text-muted-foreground">
                        Turning git on: a branch without the workspace gets the first export; an empty server imports; both with content
                        asks which wins. Drafts become the working copy of the environment's branch (refused on a protected environment).
                    </p>
                </div>
            </section>
            <TopologyEditor key={state.branches[CONFIG_BRANCH] ?? 'none'} />
        </div>
    );
}

const MODES: Mode[] = ['direct', 'pull-request', 'protected'];

function TopologyEditor() {
    const { state, act } = useStore();
    const [rows, setRows] = useState<(EnvDecl & { targets: string })[]>(() =>
        topology(state).map(e => ({ ...e, targets: e.promotesTo.join(', ') })),
    );
    const [error, setError] = useState('');
    const environments: EnvDecl[] = rows.map(({ targets, ...e }) => ({
        ...e,
        promotesTo: targets
            .split(',')
            .map(x => x.trim())
            .filter(Boolean),
    }));
    const problems = topologyProblems(environments);
    const exists = !!state.branches[CONFIG_BRANCH];
    const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
    return (
        <section className="grid gap-4">
            <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">Topology</h2>
                <Pill>
                    <span className="font-mono">topology.yaml</span> on <span className="font-mono">{CONFIG_BRANCH}</span>
                </Pill>
            </div>
            <p className="text-sm text-muted-foreground">
                Shared by every server: a change is a commit on {CONFIG_BRANCH}, outside the pipeline, protected by the provider like any
                branch. An environment has one source at most. The mode says what the app offers; the provider still enforces the
                protection.
            </p>
            {!exists && <Banner tone="warn">{CONFIG_BRANCH} does not exist yet: saving creates it.</Banner>}
            <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2">Environment</th>
                            <th className="px-3 py-2">Label</th>
                            <th className="px-3 py-2">Branch</th>
                            <th className="px-3 py-2">Promotes to</th>
                            <th className="px-3 py-2">Mode</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, i) => (
                            <tr key={i} className="border-t">
                                <td className="px-3 py-1.5">
                                    <Input className="h-8 font-mono" value={row.env} onChange={e => set(i, { env: e.target.value })} />
                                </td>
                                <td className="px-3 py-1.5">
                                    <Input className="h-8" value={row.label} onChange={e => set(i, { label: e.target.value })} />
                                </td>
                                <td className="px-3 py-1.5">
                                    <Input
                                        className="h-8 font-mono"
                                        value={row.branch}
                                        onChange={e => set(i, { branch: e.target.value })}
                                    />
                                </td>
                                <td className="px-3 py-1.5">
                                    <Input
                                        className="h-8 font-mono"
                                        placeholder="PROD, SANDBOX"
                                        value={row.targets}
                                        onChange={e => set(i, { targets: e.target.value })}
                                    />
                                </td>
                                <td className="px-3 py-1.5">
                                    <select
                                        className="h-8 rounded-md border bg-background px-2"
                                        value={row.mode}
                                        onChange={e => set(i, { mode: e.target.value as Mode })}
                                    >
                                        {MODES.map(mode => (
                                            <option key={mode}>{mode}</option>
                                        ))}
                                    </select>
                                </td>
                                <td className="px-2">
                                    <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        aria-label="Remove"
                                        onClick={() => setRows(rows.filter((_, j) => j !== i))}
                                    >
                                        <Trash2 />
                                    </Button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {problems.length > 0 && <Banner tone="bad">{problems.join(' ')}</Banner>}
            {error && <Banner tone="bad">{error}</Banner>}
            <div className="flex gap-2">
                <Button
                    variant="outline"
                    onClick={() =>
                        setRows([...rows, { env: 'NEW', label: 'New', branch: 'new', promotesTo: [], targets: '', mode: 'protected' }])
                    }
                >
                    <Plus /> Environment
                </Button>
                <Button disabled={problems.length > 0} onClick={() => setError(act(d => saveTopology(d, environments)) ?? '')}>
                    Commit the topology
                </Button>
            </div>
        </section>
    );
}

export function ConnectionsPage() {
    const { state, act } = useStore();
    const s = server(state);
    const [creating, setCreating] = useState(false);
    const declared = s.gitOn ? parseWorkspace(workingTree(state)).connections : [];
    const rows = Object.values(s.connections);
    return (
        <div className="grid gap-4">
            <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold">Connections</h1>
                <Button className="ml-auto" onClick={() => setCreating(true)}>
                    <Plus /> New connection
                </Button>
            </div>
            {s.gitOn && (
                <p className="text-sm text-muted-foreground">
                    Git holds one file per connection, <span className="font-mono">connections/&lt;name&gt;.yaml</span> with its id and
                    type; {s.env} holds its configuration and credentials. A new connection exists in {s.env} at once; its file is a change
                    of your branch.
                </p>
            )}
            <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                        <th className="py-2">Name</th>
                        <th>Type</th>
                        <th>Id</th>
                        {s.gitOn && <th>Declared on this branch</th>}
                        <th>In {s.env}</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {rows.map(row => {
                        const isDeclared = declared.some(c => c.id === row.id);
                        return (
                            <tr key={row.id} className="border-t">
                                <td className="py-2">{row.name}</td>
                                <td>{row.type}</td>
                                <td className="font-mono text-xs">{row.id}</td>
                                {s.gitOn && (
                                    <td>
                                        {isDeclared ? (
                                            <Pill tone="ok">declared</Pill>
                                        ) : (
                                            <Pill tone="warn">unused: declared on no branch here</Pill>
                                        )}
                                    </td>
                                )}
                                <td>{row.configured ? <Pill tone="ok">configured</Pill> : <Pill tone="warn">not configured</Pill>}</td>
                                <td className="text-right">
                                    {!row.configured && (
                                        <Button
                                            size="xs"
                                            variant="outline"
                                            onClick={() =>
                                                act(d => void (d.servers[d.session.env]!.connections[row.id]!.configured = true))
                                            }
                                        >
                                            Configure (fake)
                                        </Button>
                                    )}
                                </td>
                            </tr>
                        );
                    })}
                    {declared
                        .filter(c => !s.connections[c.id])
                        .map(c => (
                            <tr key={c.path} className="border-t text-muted-foreground">
                                <td className="py-2">{c.name}</td>
                                <td>{c.type}</td>
                                <td className="font-mono text-xs">{c.id}</td>
                                <td>
                                    <Pill tone="info">declared on this branch only</Pill>
                                </td>
                                <td>
                                    <Pill>not in {s.env}</Pill>
                                </td>
                                <td />
                            </tr>
                        ))}
                </tbody>
            </table>
            <NameDialog
                open={creating}
                title="New connection"
                description={`It exists in ${s.env} at once (configured). With git, its file connections/<name>.yaml is added on your current branch; on a protected environment only inside a hotfix branch.`}
                label="Name"
                confirm="Create"
                onClose={() => setCreating(false)}
                onSubmit={name => (name.trim() ? act(d => createConnection(d, name.trim(), 'http')) : 'A name is required.')}
            />
        </div>
    );
}
