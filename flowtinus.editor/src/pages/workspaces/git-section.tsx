import { useState, type FormEvent } from 'react';
import { CircleCheck, CircleX, GitBranch, Power, TriangleAlert } from 'lucide-react';
import { ConfirmDialog, type ConfirmTarget } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useResource } from '@/data/use-resource';
import { listSecrets } from '@/data/secrets/secrets-api';
import type { ApiResult } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { CONFIG_BRANCH, createTopology, getGitConfig, getGitStatus, getTopology, getTurnOnPlan, removeGitConfig, saveGitConfig, testGitAccess, turnGitOn, type AccessTest, type FileChange, type GitConfig, type Topology, type TreeIssue, type TurnOnPlan, type TurnOnResult } from '@/data/git/git-api';

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
                        <TurnOnPanel
                            key={JSON.stringify(saved.state.value.config)}
                            slug={slug}
                            on={saved.state.value.on}
                            readOnly={readOnly}
                            run={saved.run}
                        />
                    )}
                    {saved.state.value.on && <SyncStatus key={JSON.stringify(saved.state.value.config)} slug={slug} />}
                    {saved.state.value.config && (
                        <TopologyPanel
                            key={`${JSON.stringify(saved.state.value.config)}:${saved.state.value.on}`}
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
                                    description: 'Git turns off: the workspace stops being mirrored. The repository keeps what it has.',
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

function SyncStatus({ slug }: { slug: string }) {
    const status = useResource(`git-status:${slug}`, () => getGitStatus(slug));
    const value = status.state.status === 'ready' ? status.state.value.status : null;
    if (!value) {
        return null;
    }

    if (value.pending === 0) {
        return (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <CircleCheck className="size-4 text-emerald-600" /> Git has every deploy.
            </p>
        );
    }

    return (
        <div className="grid gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm" role="status">
            <p className="flex items-start gap-2 font-medium">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                Git is behind: {value.pending} {value.pending === 1 ? 'commit' : 'commits'} not pushed
                {value.since && <span className="font-normal text-muted-foreground"> since {formatDateTime(new Date(value.since))}</span>}
            </p>
            {value.reason && <p className="break-words pl-6 text-muted-foreground">{value.reason}</p>}
            <p className="pl-6 text-xs text-muted-foreground">The deploys stand; the next deploy or undeploy pushes them.</p>
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

const OUTCOMES: Record<TurnOnResult['outcome'], (branch: string) => string> = {
    exported: branch => `Git is on: the first export is the first commit of ${branch}.`,
    imported: branch => `Git is on: the workspace was imported from ${branch}.`,
    'server-replaced-git': branch => `Git is on: ${branch} now holds what is deployed here.`,
    'git-replaced-server': branch => `Git is on: this server now holds what ${branch} holds.`,
};

type TurnOnOptions = { createBranch?: boolean; choice?: 'git' | 'server' };

/** off until turned on: the first export, the import, or a choice when both sides have the workspace, each previewed */
function TurnOnPanel({
    slug,
    on,
    readOnly,
    run,
}: {
    slug: string;
    on: boolean;
    readOnly: boolean;
    /** the change, then the configuration read again (git on) */
    run: <R>(change: Promise<ApiResult<R>>) => Promise<ApiResult<R>>;
}) {
    const [plan, setPlan] = useState<TurnOnPlan | null>(null);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<{ message: string; fields: Record<string, string> } | null>(null);
    const [done, setDone] = useState<TurnOnResult | null>(null);
    const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);

    if (on) {
        return (
            <div className="grid gap-2 text-sm" role="status">
                <p className="flex items-center gap-2">
                    <CircleCheck className="size-4 text-emerald-600" />
                    {done ? OUTCOMES[done.outcome](done.branch) : 'Git is on: every deploy and change of the workspace is a commit.'}
                </p>
                {done && <Issues tone="warn" issues={done.warnings} />}
            </div>
        );
    }

    const readPlan = async () => {
        setBusy(true);
        setFailure(null);
        const result = await getTurnOnPlan(slug);
        setBusy(false);
        setPlan(result.ok ? result.value : null);
        if (!result.ok) {
            setFailure({ message: result.error.message, fields: {} });
        }
    };

    const turnOn = async (options: TurnOnOptions) => {
        setBusy(true);
        const result = await run(turnGitOn(slug, options));
        setBusy(false);
        if (result.ok) {
            setDone(result.value);
        } else {
            setFailure({ message: result.error.message, fields: result.error.fields ?? {} });
        }
        return result;
    };

    const ask = (target: Omit<ConfirmTarget, 'busyLabel' | 'onConfirm'>, options: TurnOnOptions) =>
        setConfirm({ ...target, busyLabel: 'Turning git on...', onConfirm: () => turnOn(options) });

    const files = (changes: FileChange[]) => `${changes.length} ${changes.length === 1 ? 'file' : 'files'}`;

    return (
        <div className="grid gap-3 rounded-lg border p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
                <Power className="size-4 text-muted-foreground" />
                <p className="font-medium">Git is off</p>
                <p className="text-muted-foreground">The workspace is not mirrored until git is turned on.</p>
                {!readOnly && !plan && (
                    <Button size="sm" className="ml-auto" disabled={busy} onClick={() => void readPlan()}>
                        {busy ? 'Reading the repository...' : 'Turn git on'}
                    </Button>
                )}
            </div>
            {failure && (
                <div className="grid gap-1" role="alert">
                    <p className="text-destructive">{failure.message}</p>
                    <Issues tone="error" issues={Object.entries(failure.fields).map(([path, message]) => ({ path, message }))} />
                </div>
            )}
            {plan && (
                <div className="grid gap-3">
                    {!plan.branchExists && (
                        <Check ok="warn">The branch {plan.branch} does not exist yet. It is created, empty, only when you confirm.</Check>
                    )}
                    {plan.case === 'export' && (
                        <>
                            <p>
                                {plan.branch} has no workspace {slug}: the first export makes what is deployed here its first commit. Drafts
                                stay drafts, out of git.
                            </p>
                            <Changes title={`On ${plan.branch}`} changes={plan.toGit} />
                        </>
                    )}
                    {plan.case === 'import' && (
                        <>
                            <p>
                                {plan.branch} holds the workspace {slug} and this workspace is empty: it is imported. Connections arrive not
                                configured.
                            </p>
                            <Issues tone="error" issues={plan.errors} />
                            <Issues tone="warn" issues={plan.warnings} />
                            <Changes title="Arrives here" changes={plan.toServer} />
                        </>
                    )}
                    {plan.case === 'choice' && (
                        <>
                            <p>
                                Both {plan.branch} and this server have the workspace {slug}. Nothing happens until you choose which one
                                replaces the other. Drafts stay drafts either way.
                            </p>
                            <div className="grid gap-3 md:grid-cols-2">
                                <div className="grid content-start gap-2 rounded-md border p-3">
                                    <p className="font-medium">Git replaces the server</p>
                                    <p className="text-muted-foreground">
                                        This server takes what {plan.branch} holds. A deployed flow git does not have is archived; a draft
                                        never deployed stays.
                                    </p>
                                    <Issues tone="error" issues={plan.errors} />
                                    <Changes title="Changes here" changes={plan.toServer} />
                                    {!readOnly && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="justify-self-start"
                                            disabled={busy || plan.errors.length > 0}
                                            onClick={() =>
                                                ask(
                                                    {
                                                        title: 'Git replaces the server?',
                                                        description: `This server takes the workspace ${plan.branch} holds: ${files(plan.toServer)} change here.`,
                                                        confirmLabel: 'Git replaces the server',
                                                        destructive: true,
                                                    },
                                                    { choice: 'git' },
                                                )
                                            }
                                        >
                                            Git replaces the server
                                        </Button>
                                    )}
                                </div>
                                <div className="grid content-start gap-2 rounded-md border p-3">
                                    <p className="font-medium">The server replaces git</p>
                                    <p className="text-muted-foreground">One commit makes {plan.branch} hold what is deployed here.</p>
                                    <Changes title={`On ${plan.branch}`} changes={plan.toGit} />
                                    {!readOnly && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="justify-self-start"
                                            disabled={busy}
                                            onClick={() =>
                                                ask(
                                                    {
                                                        title: 'The server replaces git?',
                                                        description: `One commit on ${plan.branch}: ${files(plan.toGit)} change.`,
                                                        confirmLabel: 'The server replaces git',
                                                        destructive: true,
                                                    },
                                                    { choice: 'server' },
                                                )
                                            }
                                        >
                                            The server replaces git
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                    {!readOnly && (
                        <div className="flex flex-wrap gap-2">
                            {plan.case !== 'choice' && (
                                <Button
                                    size="sm"
                                    disabled={busy || plan.errors.length > 0}
                                    onClick={() =>
                                        plan.branchExists
                                            ? void turnOn({})
                                            : ask(
                                                  {
                                                      title: `Create ${plan.branch}?`,
                                                      description: `The repository gets the branch ${plan.branch}, empty, then the first export of what is deployed here.`,
                                                      confirmLabel: 'Create and turn git on',
                                                  },
                                                  { createBranch: true },
                                              )
                                    }
                                >
                                    {!plan.branchExists
                                        ? `Create ${plan.branch} and turn git on`
                                        : plan.case === 'import'
                                          ? 'Import and turn git on'
                                          : 'Turn git on'}
                                </Button>
                            )}
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void readPlan()}>
                                Read again
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    setPlan(null);
                                    setFailure(null);
                                }}
                            >
                                Cancel
                            </Button>
                        </div>
                    )}
                </div>
            )}
            <ConfirmDialog target={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}

const CHANGE_MARK: Record<FileChange['change'], { mark: string; className: string }> = {
    added: { mark: '+', className: 'text-emerald-600' },
    changed: { mark: '~', className: 'text-amber-600' },
    removed: { mark: '-', className: 'text-destructive' },
};

function Changes({ title, changes }: { title: string; changes: FileChange[] }) {
    return (
        <div className="grid gap-1">
            <p className="text-xs text-muted-foreground">
                {title}: {changes.length === 0 ? 'nothing changes' : `${changes.length} ${changes.length === 1 ? 'file' : 'files'}`}
            </p>
            {changes.length > 0 && (
                <ul className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">
                    {changes.map(c => (
                        <li key={c.path} className="flex gap-2">
                            <span className={`w-3 shrink-0 ${CHANGE_MARK[c.change].className}`}>{CHANGE_MARK[c.change].mark}</span>
                            <span className="break-all">{c.path}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function Issues({ tone, issues }: { tone: 'error' | 'warn'; issues: TreeIssue[] }) {
    if (issues.length === 0) {
        return null;
    }

    return (
        <ul className="grid gap-1">
            {issues.map(issue => (
                <li key={`${issue.path}:${issue.message}`}>
                    <Check ok={tone === 'warn' ? 'warn' : false}>
                        <span className="font-mono text-xs">{issue.path}</span> {issue.message}
                    </Check>
                </li>
            ))}
        </ul>
    );
}
