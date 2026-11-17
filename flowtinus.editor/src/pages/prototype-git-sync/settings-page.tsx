import { useState } from 'react';
import { CircleCheck, CircleX, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { createConnection, server, setSettings, testAccess, workingTree } from './actions';
import { parseWorkspace, type GitSettings } from './model';
import { useStore } from './store';
import { Banner, NameDialog, Pill } from './ui';

export function SettingsPage() {
    const { state, act } = useStore();
    const s = server(state);
    const [draft, setDraft] = useState<{ env: string; gitOn: boolean; settings: GitSettings; promotes: string } | null>(null);
    const [test, setTest] = useState<{ ok: boolean; lines: string[] } | null>(null);
    const current =
        draft?.env === s.env ? draft : { env: s.env, gitOn: s.gitOn, settings: s.settings, promotes: s.settings.promotesTo.join(', ') };
    const set = (patch: Partial<typeof current>) => setDraft({ ...current, ...patch });
    const setGit = (patch: Partial<GitSettings>) => set({ settings: { ...current.settings, ...patch } });
    const settingsNow = (): GitSettings => ({
        ...current.settings,
        promotesTo: current.promotes
            .split(',')
            .map(x => x.trim())
            .filter(Boolean),
    });

    return (
        <div className="mx-auto grid w-full max-w-3xl gap-6">
            <h1 className="text-2xl font-semibold">Settings</h1>
            <section className="grid gap-4">
                <div className="flex items-center gap-3">
                    <h2 className="text-lg font-semibold">Git</h2>
                    <Pill tone="info">this server: {s.env}</Pill>
                </div>
                <Banner tone="info">
                    Prototype: each environment is its own server with its own settings (the <span className="font-mono">git</span> key in
                    its workspace_settings). Switch servers in the bottom bar to edit another one.
                </Banner>
                <label className="flex items-center gap-3 text-sm">
                    <Switch checked={current.gitOn} onCheckedChange={v => set({ gitOn: v })} />
                    Sync this workspace with git
                    <span className="text-muted-foreground">(off: the app as today, with the Deploy button)</span>
                </label>
                {current.gitOn && (
                    <div className="grid gap-4 rounded-lg border p-4">
                        <div className="grid gap-2">
                            <Label htmlFor="repo">Repository URL</Label>
                            <Input id="repo" value={current.settings.repo} onChange={e => setGit({ repo: e.target.value })} />
                            <p className="text-xs text-muted-foreground">One repository, a folder per workspace (acme/).</p>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="branch">This server's branch (its environment)</Label>
                            <Input
                                id="branch"
                                className="font-mono"
                                value={current.settings.branch}
                                onChange={e => setGit({ branch: e.target.value })}
                            />
                        </div>
                        <label className="flex items-start gap-3 text-sm">
                            <Switch checked={current.settings.directEdits} onCheckedChange={v => setGit({ directEdits: v })} />
                            <span>
                                Direct edits on <span className="font-mono">{current.settings.branch}</span>
                                <span className="block text-xs text-muted-foreground">
                                    On: people can edit and commit on the environment's branch (a commit is a deploy). Off: protected, only
                                    a branch and a PR.
                                </span>
                            </span>
                        </label>
                        <div className="grid gap-2">
                            <Label htmlFor="credential">Credential (a workspace secret)</Label>
                            <select
                                id="credential"
                                className="h-9 rounded-md border bg-background px-2 text-sm"
                                value={current.settings.credential}
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
                            <Label htmlFor="promotes">May promote to (branches, comma separated)</Label>
                            <Input
                                id="promotes"
                                className="font-mono"
                                value={current.promotes}
                                onChange={e => set({ promotes: e.target.value })}
                            />
                            <p className="text-xs text-muted-foreground">
                                Branch names: this server does not know the other servers' environment names.
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button variant="outline" onClick={() => setTest(testAccess(state, s.env, settingsNow()))}>
                                Test access
                            </Button>
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
                    </div>
                )}
                <div>
                    <Button
                        onClick={() => {
                            act(d => setSettings(d, s.env, settingsNow(), current.gitOn));
                            setDraft(null);
                            setTest(null);
                        }}
                    >
                        Save
                    </Button>
                </div>
            </section>
        </div>
    );
}

export function ConnectionsPage() {
    const { state, act } = useStore();
    const s = server(state);
    const [creating, setCreating] = useState(false);
    const declared = parseWorkspace(workingTree(state)).connections;
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
                    Git holds a connection's id, name and type (workspace.yaml); {s.env} holds its configuration and credentials. A new
                    connection exists in {s.env} at once; its declaration is a change of your branch.
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
                            <tr key={c.id} className="border-t text-muted-foreground">
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
                description={`It exists in ${s.env} at once (configured). With git, its declaration (id, name, type) is added to workspace.yaml on your current branch.`}
                label="Name"
                confirm="Create"
                onClose={() => setCreating(false)}
                onSubmit={name => (name.trim() ? act(d => createConnection(d, name.trim(), 'http')) : 'A name is required.')}
            />
        </div>
    );
}
