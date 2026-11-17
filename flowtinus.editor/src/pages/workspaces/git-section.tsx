import { useState, type FormEvent } from 'react';
import { CircleCheck, CircleX, GitBranch, TriangleAlert } from 'lucide-react';
import { ConfirmDialog, type ConfirmTarget } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useResource } from '@/data/use-resource';
import { listSecrets } from '@/data/secrets/secrets-api';
import { CONFIG_BRANCH, createTopology, getGitConfig, getTopology, removeGitConfig, saveGitConfig, testGitAccess, type AccessTest, type GitConfig, type Topology } from '@/data/git/git-api';

const EMPTY: GitConfig = { repository: '', tokenSecret: '', environment: '' };

/** The workspace's git configuration: the repository, the secret holding its token, which environment this server is. */
export function GitSection({ slug, readOnly }: { slug: string; readOnly: boolean }) {
    const saved = useResource(`git:${slug}`, () => getGitConfig(slug));

    return (
        <section className="grid gap-4">
            <div>
                <h2 className="text-lg font-semibold">Git</h2>
                <p className="text-sm text-muted-foreground">
                    Mirrors this workspace to a git repository. Without a configuration, the workspace works as it always has.
                </p>
            </div>
            {saved.state.status === 'loading' && <p className="text-sm text-muted-foreground">Loading...</p>}
            {saved.state.status === 'error' && <p className="text-sm text-destructive">{saved.state.error.message}</p>}
            {saved.state.status === 'ready' && (
                <>
                    <GitForm
                        key={JSON.stringify(saved.state.value.config)}
                        slug={slug}
                        saved={saved.state.value.config}
                        readOnly={readOnly}
                        onChanged={saved.reload}
                    />
                    {saved.state.value.config && (
                        <TopologyPanel
                            key={JSON.stringify(saved.state.value.config)}
                            slug={slug}
                            config={saved.state.value.config}
                            readOnly={readOnly}
                        />
                    )}
                </>
            )}
        </section>
    );
}

function GitForm({
    slug,
    saved,
    readOnly,
    onChanged,
}: {
    slug: string;
    saved: GitConfig | null;
    readOnly: boolean;
    onChanged: () => Promise<void>;
}) {
    const secrets = useResource(`secrets:${slug}`, listSecrets);
    const [config, setConfig] = useState<GitConfig>(saved ?? EMPTY);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState<'' | 'test' | 'save'>('');
    const [test, setTest] = useState<AccessTest | null>(null);
    const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
    const set = (patch: Partial<GitConfig>) => {
        setConfig({ ...config, ...patch });
        setTest(null);
        setMessage('');
    };
    const trimmed = { repository: config.repository.trim(), tokenSecret: config.tokenSecret, environment: config.environment.trim() };
    const complete = !!(trimmed.repository && trimmed.tokenSecret && trimmed.environment);
    const changed = JSON.stringify(trimmed) !== JSON.stringify(saved ?? EMPTY);
    const secretNames = secrets.state.status === 'ready' ? secrets.state.value.map(s => s.name) : [];

    const runTest = async () => {
        setBusy('test');
        const result = await testGitAccess(slug, trimmed);
        setBusy('');
        setErrors(result.ok ? {} : (result.error.fields ?? {}));
        setMessage(result.ok || result.error.fields ? '' : result.error.message);
        setTest(result.ok ? result.value : null);
    };

    const save = async (event: FormEvent) => {
        event.preventDefault();
        setBusy('save');
        const result = await saveGitConfig(slug, trimmed);
        setBusy('');
        setErrors(result.ok ? {} : (result.error.fields ?? {}));
        setMessage(result.ok ? '' : result.error.fields ? '' : result.error.message);
        if (result.ok) {
            await onChanged();
        }
    };

    return (
        <form onSubmit={save} className="grid gap-4 rounded-lg border p-4">
            <div className="grid gap-2">
                <Label htmlFor="git-repository">Repository URL</Label>
                <Input
                    id="git-repository"
                    className="font-mono"
                    placeholder="https://gitlab.example.com/team/flows.git"
                    value={config.repository}
                    disabled={readOnly}
                    onChange={e => set({ repository: e.target.value })}
                />
                {errors.repository ? (
                    <p className="text-xs text-destructive">{errors.repository}</p>
                ) : (
                    <p className="text-xs text-muted-foreground">HTTP(S) with an access token; SSH comes later.</p>
                )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                    <Label htmlFor="git-token">Token (a workspace secret)</Label>
                    <select
                        id="git-token"
                        className="h-9 rounded-md border bg-background px-2 text-sm"
                        value={config.tokenSecret}
                        disabled={readOnly}
                        onChange={e => set({ tokenSecret: e.target.value })}
                    >
                        <option value="">Choose a secret</option>
                        {[...new Set([...(config.tokenSecret ? [config.tokenSecret] : []), ...secretNames])].map(name => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </select>
                    {errors.tokenSecret ? (
                        <p className="text-xs text-destructive">{errors.tokenSecret}</p>
                    ) : (
                        <p className="text-xs text-muted-foreground">It needs to read and write the repository.</p>
                    )}
                </div>
                <div className="grid gap-2">
                    <Label htmlFor="git-environment">This server is</Label>
                    <Input
                        id="git-environment"
                        className="font-mono"
                        placeholder="DEV"
                        value={config.environment}
                        disabled={readOnly}
                        onChange={e => set({ environment: e.target.value })}
                    />
                    {errors.environment ? (
                        <p className="text-xs text-destructive">{errors.environment}</p>
                    ) : (
                        <p className="text-xs text-muted-foreground">Its environment in the topology, on {CONFIG_BRANCH}.</p>
                    )}
                </div>
            </div>
            {!readOnly && (
                <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" disabled={!complete || busy !== ''} onClick={() => void runTest()}>
                        {busy === 'test' ? 'Testing...' : 'Test access'}
                    </Button>
                    <Button type="submit" disabled={!complete || !changed || busy !== ''}>
                        {busy === 'save' ? 'Saving...' : 'Save'}
                    </Button>
                    {saved && (
                        <Button
                            type="button"
                            variant="ghost"
                            className="ml-auto"
                            onClick={() =>
                                setConfirm({
                                    title: 'Remove the git configuration?',
                                    description: 'The workspace stops being mirrored to git. The repository keeps what it has.',
                                    confirmLabel: 'Remove',
                                    busyLabel: 'Removing...',
                                    destructive: true,
                                    onConfirm: async () => {
                                        const result = await removeGitConfig(slug);
                                        if (result.ok) {
                                            await onChanged();
                                        }
                                        return result;
                                    },
                                })
                            }
                        >
                            Remove
                        </Button>
                    )}
                    {message && <span className="text-sm text-destructive">{message}</span>}
                </div>
            )}
            {test && <AccessTestResult test={test} environment={trimmed.environment} />}
            <ConfirmDialog target={confirm} onClose={() => setConfirm(null)} />
        </form>
    );
}

function Check({ ok, children }: { ok: boolean | 'warn'; children: React.ReactNode }) {
    return (
        <p className="flex items-start gap-2">
            {ok === 'warn' ? (
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            ) : ok ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            ) : (
                <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
            )}
            <span className="break-words">{children}</span>
        </p>
    );
}

function AccessTestResult({ test, environment }: { test: AccessTest; environment: string }) {
    const topology = test.topology;
    return (
        <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm" role="status">
            <p className="font-medium">{test.ok ? 'The access works.' : 'The access does not work.'}</p>
            {test.checks.map(check => (
                <Check key={check.step} ok={check.ok}>
                    {check.message}
                </Check>
            ))}
            {topology && !topology.exists && <Check ok="warn">{CONFIG_BRANCH} does not exist yet: save, then create it below.</Check>}
            {topology?.exists && (
                <Check ok={topology.environment ? true : 'warn'}>
                    {topology.environment
                        ? `${environment} is in the topology: branch ${topology.environment.branch}, mode ${topology.environment.mode}.`
                        : `${environment} is not in the topology on ${CONFIG_BRANCH}.`}
                </Check>
            )}
            <p className="text-xs text-muted-foreground">{test.note}</p>
        </div>
    );
}

function TopologyPanel({ slug, config, readOnly }: { slug: string; config: GitConfig; readOnly: boolean }) {
    const topology = useResource(`topology:${slug}`, () => getTopology(slug));
    const [branch, setBranch] = useState(config.environment.toLowerCase());
    const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);

    const create = () =>
        setConfirm({
            title: `Create ${CONFIG_BRANCH}?`,
            description: `The repository gets the branch ${CONFIG_BRANCH} with topology.yaml, holding ${config.environment} alone: branch ${branch.trim()}, mode direct. Every server of this workspace reads its environments from it.`,
            confirmLabel: 'Create',
            busyLabel: 'Creating...',
            onConfirm: () => topology.run(createTopology(slug, { branch: branch.trim() })),
        });

    return (
        <div className="grid gap-3">
            <div className="flex items-center gap-2">
                <GitBranch className="size-4 text-muted-foreground" />
                <h3 className="font-medium">Topology</h3>
                <span className="font-mono text-xs text-muted-foreground">topology.yaml on {CONFIG_BRANCH}</span>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void topology.reload()}>
                    Reload
                </Button>
            </div>
            {topology.state.status === 'loading' && <p className="text-sm text-muted-foreground">Reading the repository...</p>}
            {topology.state.status === 'error' && <p className="text-sm text-destructive">{topology.state.error.message}</p>}
            {topology.state.status === 'ready' && !topology.state.value.topology.exists && (
                <div className="grid gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                    <p className="flex items-start gap-2">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                        The repository has no {CONFIG_BRANCH} branch, where every server reads the environments from.
                    </p>
                    {!readOnly && (
                        <div className="flex flex-wrap items-end gap-2">
                            <div className="grid gap-1">
                                <Label htmlFor="git-env-branch" className="text-xs">
                                    Branch of {config.environment}
                                </Label>
                                <Input
                                    id="git-env-branch"
                                    className="h-8 w-48 font-mono"
                                    value={branch}
                                    onChange={e => setBranch(e.target.value)}
                                />
                            </div>
                            <Button size="sm" disabled={!branch.trim()} onClick={create}>
                                Create {CONFIG_BRANCH}
                            </Button>
                        </div>
                    )}
                </div>
            )}
            {topology.state.status === 'ready' && topology.state.value.topology.exists && (
                <TopologyTable topology={topology.state.value.topology} environment={config.environment} />
            )}
            <ConfirmDialog target={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}

function TopologyTable({ topology, environment }: { topology: Extract<Topology, { exists: true }>; environment: string }) {
    return (
        <div className="grid gap-2">
            <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">Environment</th>
                            <th className="px-3 py-2 font-medium">Label</th>
                            <th className="px-3 py-2 font-medium">Branch</th>
                            <th className="px-3 py-2 font-medium">Promotes to</th>
                            <th className="px-3 py-2 font-medium">Mode</th>
                        </tr>
                    </thead>
                    <tbody>
                        {topology.environments.map(e => (
                            <tr key={e.env} className={`border-t ${e.env === environment ? 'bg-primary/5' : ''}`}>
                                <td className="px-3 py-2 font-mono">
                                    {e.env}
                                    {e.env === environment && (
                                        <span className="ml-2 font-sans text-xs text-muted-foreground">this server</span>
                                    )}
                                </td>
                                <td className="px-3 py-2">{e.label}</td>
                                <td className="px-3 py-2 font-mono">{e.branch}</td>
                                <td className="px-3 py-2 font-mono">{e.promotesTo.join(', ') || '-'}</td>
                                <td className="px-3 py-2">{e.mode}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {topology.environment && !topology.branchExists && (
                <p className="text-sm text-muted-foreground">The branch {topology.environment.branch} does not exist yet.</p>
            )}
            {topology.problems.map(problem => (
                <p key={problem} className="flex items-start gap-2 text-sm text-destructive">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    {problem}
                </p>
            ))}
        </div>
    );
}
