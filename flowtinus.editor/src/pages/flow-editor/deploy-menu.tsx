import { useEffect, useMemo, useState } from 'react';
import { CircleCheck, CircleOff, Copy, ExternalLink, GitMerge, GitCommitHorizontal, GitCompareArrows, GitPullRequestArrow, History, LoaderCircle, Rocket, RotateCcw, TriangleAlert, Undo2, Upload } from 'lucide-react';
import { flowChanges, type ComparedNode, type FlowFile } from '@flowtinus/core';
import { componentInfo } from '@/editor/catalog';
import type { ConfirmTarget } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { deployedVersion, deployState, eventText, nextNumber, NO_DEPLOYMENTS, shortSha, switchAction, type DeployState, type EmergencyRollback, type FlowDeployments, type FlowVersion } from '@/data/deployments/deployment';
import { deployFlow, deployVersion, discardDraft, emergencyRollback, emergencyRollbackChecks, endEmergencyRollback, getDeployments, makeGitMatch, restoreDraft, undeployFlow, type GitMatchBranch } from '@/data/deployments/deployments-api';
import { EmergencyRollbackBadge } from '@/components/emergency-rollback-badge';
import { Link } from 'react-router';
import { RUNS_PATH } from '@/app/paths';
import { CHANGES_CHANGED, getChanges, ONLY_PULL_REQUESTS, pullRequestNamed } from '@/data/git/git-api';
import { useUnsavedWork } from '@/data/git/unsaved-work';
import { CommitFiles } from './commit-files';
import { ArrivedDisabledList } from '@/components/arrived-disabled-list';
import { useTriggersChanged } from './use-triggers-changed';
import { ConflictDialog } from '@/layout/conflict-dialog';
import type { FlushResult } from '@/editor/flow-save';
import type { ApiResult } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

/** the chip on the Deploy button */
export function DeployBadge({ state, emergencyRollback }: { state: DeployState; emergencyRollback?: EmergencyRollback }) {
    if (state.kind === 'not-deployed') {
        return <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Not deployed</span>;
    }

    if (emergencyRollback) {
        return <EmergencyRollbackBadge {...emergencyRollback} small />;
    }

    return (
        <span
            className={cn(
                'rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium',
                state.changed
                    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                    : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
            )}
            title={state.changed ? `The draft changed since v${state.version.number}` : `v${state.version.number} is deployed`}
        >
            v{state.version.number}
            {state.changed && ' · changed'}
        </span>
    );
}

type Props = {
    flowId: string;
    workspace: string;
    /** the server's environment (DEV, QA…): a deploy is to this one */
    environment: string;
    /** archived, or the server away */
    disabled: boolean;
    /** the canvas as it is now */
    draftNow: () => FlowFile | null;
    /** changes when the draft is saved (the badge compares again) */
    saveMark: unknown;
    /** saves what is pending: a deploy takes the saved draft */
    flush: () => Promise<FlushResult>;
    /** the draft was replaced on the server: the canvas reads it again */
    onDraftReplaced: () => void;
    confirm: (target: ConfirmTarget) => void;
    /** the deployed version, each time it changes (null: not deployed): Schedules needs one */
    onDeployed?: (version: FlowVersion | null) => void;
};

/**
 * Deploy in the canvas's tools (after Group): the state (not deployed, the deployed version, the draft changed since),
 * Deploy the draft, the versions (deploy or roll back to one, restore the draft from one), Undeploy.
 */
export function DeployMenu({
    flowId,
    workspace,
    environment,
    disabled,
    draftNow,
    saveMark,
    flush,
    onDraftReplaced,
    confirm,
    onDeployed,
}: Props) {
    const [deployments, setDeployments] = useState<{ flowId: string; value: FlowDeployments } | null>(null);
    const [busy, setBusy] = useState(false);
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [compareOpen, setCompareOpen] = useState(false);
    const [resolving, setResolving] = useState<string | null>(null);
    const unsaved = useUnsavedWork();
    const [committing, setCommitting] = useState<{ number: number; warnings: string[]; saved: boolean; scripts: string[] } | null>(null);
    const current = deployments?.flowId === flowId ? deployments.value : NO_DEPLOYMENTS;
    const git = current.git;
    const target = git ? (git.branch ?? 'git') : environment;
    // a pull-request or protected environment takes the tree's changes only from git
    const pullRequestsOnly = !!git && git.mode !== 'direct';
    const rollback = current.emergencyRollback;
    const [pushed, setPushed] = useState<{ flowId: string; versionId: string; value: GitMatchBranch } | null>(null);

    useEffect(() => {
        let gone = false;
        void getDeployments(flowId).then(result => !gone && result.ok && setDeployments({ flowId, value: result.value }));
        return () => {
            gone = true;
        };
    }, [flowId]);
    useTriggersChanged(async () => {
        const result = await getDeployments(flowId);
        if (result.ok) {
            setDeployments({ flowId, value: result.value });
        }
    });

    // compared again when the deployments change and each time the draft is saved (saveMark)
    const state = useMemo(() => {
        void saveMark;
        return deployState(current, draftNow());
    }, [current, draftNow, saveMark]);
    const deployed = deployedVersion(current);
    const loadedFor = deployments?.flowId === flowId;
    useEffect(() => {
        if (loadedFor) {
            onDeployed?.(deployed ?? null);
        }
    }, [loadedFor, deployed, onDeployed]);

    /** runs an action that answers the new deployments (the dialog shows its error) */
    const act = async (action: () => Promise<ApiResult<FlowDeployments>>): Promise<ApiResult<FlowDeployments>> => {
        setBusy(true);
        const result = await action();
        // refused (a draft found in conflict with git, say): what is true now is read again
        const fresh = result.ok ? result : await getDeployments(flowId);
        setBusy(false);
        if (fresh.ok) {
            setDeployments({ flowId, value: fresh.value });
        }
        if (result.ok && git) {
            window.dispatchEvent(new Event(CHANGES_CHANGED));
        }

        return result;
    };

    const conflict = current.draftConflict;
    const resolve = (copy: boolean) => {
        const name = `${draftNow()?.name ?? 'Flow'} (my draft)`;
        confirm({
            title: copy ? `Duplicate the draft as "${name}"?` : "Discard the draft and take git's?",
            description: copy
                ? `A new flow, a draft only, keeps your draft; this one takes git's content at ${target}.`
                : `The draft's changes are lost; it takes git's content at ${target}.`,
            confirmLabel: copy ? 'Duplicate and take git’s' : 'Discard draft',
            busyLabel: copy ? 'Duplicating…' : 'Discarding…',
            destructive: !copy,
            onConfirm: async () => {
                const result = await discardDraft(flowId, copy ? name : undefined);
                if (result.ok) {
                    onDraftReplaced();
                    const fresh = await getDeployments(flowId);
                    if (fresh.ok) {
                        setDeployments({ flowId, value: fresh.value });
                    }
                }
                return result;
            },
        });
    };

    const openConflict = async () => {
        const result = await getChanges(workspace);
        const change = result.ok ? result.value.changes.find(c => c.fileId === flowId && c.conflict) : undefined;
        if (change) {
            setResolving(change.path);
        }
    };
    const resolved = async () => {
        onDraftReplaced();
        const fresh = await getDeployments(flowId);
        if (fresh.ok) {
            setDeployments({ flowId, value: fresh.value });
        }
    };

    const deploy = async () => {
        // the deploy takes the saved draft: what is pending goes first, then what deploying it would leave broken
        setBusy(true);
        const saved = await flush();
        const fresh = saved === 'saved' ? await getDeployments(flowId) : null;
        setBusy(false);
        if (fresh?.ok) {
            setDeployments({ flowId, value: fresh.value });
        }

        const latest = fresh?.ok ? fresh.value : current;
        const before = deployedVersion(latest);
        const warnings = latest.warnings ?? [];
        if (latest.git) {
            setCommitting({
                number: nextNumber(latest, draftNow()),
                warnings,
                saved: saved === 'saved',
                scripts: latest.changedScripts ?? [],
            });
            return;
        }

        confirm({
            title: `Deploy v${nextNumber(latest, draftNow())} to ${environment}?`,
            description: (
                <>
                    {saved !== 'saved'
                        ? 'The draft could not be saved: what is pending is not deployed.'
                        : before
                          ? `Replaces v${before.number}.`
                          : 'First deploy of this flow.'}
                    {warnings.length > 0 && (
                        <span className="mt-2 flex flex-col gap-1 text-amber-700 dark:text-amber-400">
                            {warnings.map(w => (
                                <span key={w} className="flex gap-1.5">
                                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {w}
                                </span>
                            ))}
                        </span>
                    )}
                </>
            ),
            confirmLabel: 'Deploy',
            busyLabel: 'Deploying…',
            onConfirm: () => act(() => deployFlow(flowId)),
        });
    };

    const switchTo = (version: FlowVersion) => {
        const action = switchAction(current, version);
        const newest = current.versions[0]?.number ?? version.number;
        if (git) {
            confirm({
                title: version.number < newest ? `Commit a revert to v${version.number}?` : `Commit v${version.number} to ${target}?`,
                description: (
                    <>
                        {`A commit to ${target} of v${version.number}'s content, deployed as a new version.${deployed ? ` Replaces v${deployed.number}.` : ''}`}
                        {version.endsEmergencyRollback && (
                            <span className="mt-2 flex gap-1.5 text-amber-700 dark:text-amber-400">
                                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {version.endsEmergencyRollback}
                            </span>
                        )}
                    </>
                ),
                confirmLabel: 'Commit',
                busyLabel: 'Committing…',
                onConfirm: () => act(() => deployVersion(flowId, version.id)),
            });
            return;
        }

        confirm({
            title: action === 'rollback' ? `Roll back to v${version.number}?` : `Deploy v${version.number} to ${environment}?`,
            description: deployed ? `Replaces v${deployed.number}.` : `Nothing is deployed now.`,
            confirmLabel: action === 'rollback' ? 'Roll back' : 'Deploy',
            busyLabel: action === 'rollback' ? 'Rolling back…' : 'Deploying…',
            destructive: action === 'rollback',
            onConfirm: () => act(() => deployVersion(flowId, version.id)),
        });
    };

    const runsOf = (status: 'running' | 'queued') => `${RUNS_PATH}?${new URLSearchParams({ workspace, status, flow: flowId })}`;

    const rollBackTo = async (version: FlowVersion) => {
        setBusy(true);
        const checks = await emergencyRollbackChecks(flowId, version.id);
        setBusy(false);
        // checks that could not be read: the rollback itself checks again and says why it is refused
        const { errors, warnings } = checks.ok ? checks.value : { errors: [], warnings: [] };
        confirm({
            title: `Emergency rollback to v${version.number}?`,
            description: (
                <>
                    {environment} runs v{version.number} instead of git's v{rollback?.gitNumber ?? deployed?.number}, without a commit,
                    until a commit changes this flow's content or the rollback is ended. Only the nodes and edges go back: the scripts stay
                    the last applied commit's, and the triggers are not part of the content. Runs in progress and queued keep their version,
                    as do the flows they call: stop them by hand if needed (
                    <Link className="underline" to={runsOf('running')}>
                        running
                    </Link>
                    ,{' '}
                    <Link className="underline" to={runsOf('queued')}>
                        queued
                    </Link>
                    ).
                </>
            ),
            ...(errors.length || warnings.length
                ? {
                      warning: (
                          <ul className="list-disc space-y-1 pl-4">
                              {errors.map(error => (
                                  <li key={error} className="text-destructive">
                                      Refused: {error}
                                  </li>
                              ))}
                              {warnings.map(warning => (
                                  <li key={warning}>{warning}</li>
                              ))}
                          </ul>
                      ),
                  }
                : {}),
            confirmLabel: 'Roll back',
            busyLabel: 'Rolling back…',
            destructive: true,
            onConfirm: () => act(() => emergencyRollback(flowId, version.id)),
        });
    };

    const endRollback = (ended: EmergencyRollback) =>
        confirm({
            title: 'End the emergency rollback?',
            description: `${environment} runs git's v${ended.gitNumber} again, instead of v${ended.number}.`,
            confirmLabel: 'End the emergency rollback',
            busyLabel: 'Ending…',
            destructive: true,
            onConfirm: () => act(() => endEmergencyRollback(flowId)),
        });

    const matchGit = (rolledBack: EmergencyRollback) =>
        confirm({
            title: 'Make git match what runs?',
            description: pullRequestsOnly
                ? `Pushes a branch cut from ${target} with v${rolledBack.number}'s content of this flow, and opens its pull request. Once it is merged, the emergency rollback ends: ${environment} runs that content as a new version.`
                : `Commits v${rolledBack.number}'s content of this flow to ${target}. The emergency rollback ends: ${environment} runs that content as a new version.`,
            confirmLabel: pullRequestsOnly ? 'Push and open the pull request' : 'Commit',
            busyLabel: pullRequestsOnly ? 'Pushing…' : 'Committing…',
            onConfirm: () =>
                act(async () => {
                    await flush();
                    const result = await makeGitMatch(flowId);
                    if (result.ok && result.value.pushed) {
                        setPushed({ flowId, versionId: rolledBack.versionId, value: result.value.pushed });
                    } else if (result.ok) {
                        onDraftReplaced();
                    }
                    return result;
                }),
        });

    const restore = (version: FlowVersion) =>
        confirm({
            title: `Restore the draft from v${version.number}?`,
            description: 'The draft as it is now is replaced.',
            confirmLabel: 'Restore draft',
            busyLabel: 'Restoring…',
            destructive: true,
            onConfirm: async () => {
                await flush();
                const result = await restoreDraft(flowId, version.id);
                if (result.ok) {
                    setVersionsOpen(false);
                    onDraftReplaced();
                }

                return result;
            },
        });

    const undeploy = () =>
        confirm({
            title: git ? `Commit an undeploy to ${target}?` : `Undeploy from ${environment}?`,
            description: deployed
                ? `v${deployed.number} stops being deployed${git ? ': its file stays, with deployed: false' : ''}. Its versions are kept.`
                : '',
            confirmLabel: git ? 'Commit undeploy' : 'Undeploy',
            busyLabel: git ? 'Committing…' : 'Undeploying…',
            destructive: true,
            onConfirm: () => act(() => undeployFlow(flowId)),
        });

    const nothingToDeploy = state.kind === 'deployed' && !state.changed && !current.changedScripts?.length && !current.triggersChanged;

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        className="bg-card shadow-md"
                        disabled={disabled}
                        aria-label={git ? `Commit to ${target}` : 'Deploy'}
                    >
                        {busy ? <LoaderCircle className="animate-spin" /> : git ? <GitCommitHorizontal /> : <Rocket />}
                        {git ? `Commit to ${target}` : 'Deploy'}
                        {conflict ? (
                            <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-400">
                                Conflict
                            </span>
                        ) : (
                            <DeployBadge state={state} emergencyRollback={rollback} />
                        )}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                    <DropdownMenuLabel className="font-normal text-muted-foreground">
                        {deployed && current.deployed && rollback ? (
                            <>
                                <span className="font-medium text-foreground">v{deployed.number}</span> runs on {environment} · {target} has
                                v{rollback.gitNumber}
                            </>
                        ) : deployed && current.deployed ? (
                            <>
                                <span className="font-medium text-foreground">v{deployed.number}</span> {git ? 'on' : 'in'} {target} ·{' '}
                                <span title={formatDateTime(current.deployed.deployedAt)}>{relativeTime(current.deployed.deployedAt)}</span>
                                {current.deployed.deployedByName && ` · ${current.deployed.deployedByName}`}
                            </>
                        ) : (
                            `Not deployed ${git ? 'on' : 'in'} ${target}`
                        )}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {conflict && (
                        <>
                            <DropdownMenuLabel className="font-normal text-red-700 dark:text-red-400">
                                The draft conflicts with git&apos;s commit <span className="font-mono">{shortSha(conflict)}</span>
                            </DropdownMenuLabel>
                            <DropdownMenuItem disabled={busy} onSelect={() => void openConflict()}>
                                <TriangleAlert /> Resolve the conflict...
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={busy} onSelect={() => resolve(false)}>
                                <GitMerge /> Discard draft, take git&apos;s
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={busy} onSelect={() => resolve(true)}>
                                <Copy /> Duplicate draft as a new flow
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                        </>
                    )}
                    {pullRequestsOnly && (
                        <>
                            <DropdownMenuLabel className="font-normal text-amber-700 dark:text-amber-400">
                                {ONLY_PULL_REQUESTS}
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                        </>
                    )}
                    <DropdownMenuItem
                        disabled={busy || nothingToDeploy || !!conflict || pullRequestsOnly || !!unsaved}
                        onSelect={() => void deploy()}
                    >
                        {git ? <GitCommitHorizontal /> : <Upload />} {git ? 'Commit' : 'Deploy'} draft as v{nextNumber(current, draftNow())}
                        {unsaved && <span className="ml-auto text-xs text-muted-foreground">saving…</span>}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={current.versions.length === 0} onSelect={() => setVersionsOpen(true)}>
                        <History /> Versions
                        {current.versions.length > 0 && (
                            <span className="ml-auto text-xs text-muted-foreground">{current.versions.length}</span>
                        )}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!deployed} onSelect={() => setCompareOpen(true)}>
                        <GitCompareArrows /> Compare draft with deployed
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" disabled={busy || !deployed || pullRequestsOnly} onSelect={undeploy}>
                        <CircleOff /> {git ? 'Commit undeploy' : 'Undeploy'}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <VersionsDialog
                open={versionsOpen}
                onClose={() => setVersionsOpen(false)}
                deployments={current}
                busy={busy}
                onSwitch={pullRequestsOnly ? undefined : switchTo}
                onEmergencyRollback={git ? rollBackTo : undefined}
                onEndEmergencyRollback={rollback ? () => endRollback(rollback) : undefined}
                onRestore={restore}
            />
            {rollback && (
                <EmergencyRollbackBanner
                    rollback={rollback}
                    environment={environment}
                    busy={busy || disabled}
                    pushed={pushed?.flowId === flowId && pushed.versionId === rollback.versionId ? pushed.value : null}
                    onMatchGit={() => matchGit(rollback)}
                    onEnd={() => endRollback(rollback)}
                />
            )}
            {deployed && compareOpen && <CompareDialog onClose={() => setCompareOpen(false)} version={deployed} draft={draftNow()} />}
            {committing && (
                <CommitDialog
                    branch={target}
                    workspace={workspace}
                    flowId={flowId}
                    number={committing.number}
                    running={deployed?.id ?? null}
                    flowName={draftNow()?.name ?? 'flow'}
                    warnings={committing.warnings}
                    saved={committing.saved}
                    scripts={committing.scripts}
                    onCommit={(message, scripts) => act(() => deployFlow(flowId, message, scripts))}
                    onClose={() => setCommitting(null)}
                />
            )}
            {resolving && (
                <ConflictDialog handle={workspace} path={resolving} onClose={() => setResolving(null)} onResolved={() => void resolved()} />
            )}
        </>
    );
}

function EmergencyRollbackBanner(props: {
    rollback: EmergencyRollback;
    environment: string;
    busy: boolean;
    pushed: GitMatchBranch | null;
    onMatchGit: () => void;
    onEnd: () => void;
}) {
    const { rollback, environment, busy, pushed, onMatchGit, onEnd } = props;
    return (
        <div className="flex basis-full justify-end">
            <div
                role="status"
                className="flex max-w-2xl flex-wrap items-center gap-3 rounded-md border border-red-500/40 bg-card px-3 py-2 text-sm shadow-md"
            >
                <TriangleAlert className="size-4 shrink-0 text-red-600 dark:text-red-400" />
                <span className="min-w-0">
                    <span className="font-medium">Emergency rollback:</span> {environment} runs v{rollback.number}, git has v
                    {rollback.gitNumber}.{' '}
                    <span className="text-muted-foreground" title={formatDateTime(rollback.at)}>
                        {rollback.byName ?? rollback.by ?? 'Someone'} · {relativeTime(rollback.at)}
                    </span>
                </span>
                <Button variant="outline" size="sm" className="shrink-0" disabled={busy} onClick={onMatchGit}>
                    <GitCommitHorizontal /> Make git match what runs
                </Button>
                <Button variant="outline" size="sm" className="shrink-0" disabled={busy} onClick={onEnd}>
                    <Undo2 /> End the emergency rollback
                </Button>
                {pushed && (
                    <span className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                        <span>
                            <GitPullRequestArrow className="mr-1 inline size-4" />
                            {pushed.reused ? 'Already pushed: ' : 'Pushed '}
                            <span className="font-mono">{pushed.branch}</span>, into <span className="font-mono">{pushed.target}</span>.
                        </span>
                        {pushed.url && (
                            <a
                                href={pushed.url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                            >
                                {pushed.mergeRequest && pushed.provider
                                    ? `Open ${pullRequestNamed(pushed.provider, pushed.mergeRequest.number)}`
                                    : 'Open the pull request'}
                                <ExternalLink className="size-3.5" />
                            </a>
                        )}
                        {pushed.notice && <span className="basis-full text-amber-700 dark:text-amber-400">{pushed.notice}</span>}
                    </span>
                )}
            </div>
        </div>
    );
}

/** the Commit of the draft: its message, then the commit applied or why the branch refused it */
function CommitDialog(props: {
    branch: string;
    number: number;
    /** the version deployed when the dialog opened: a commit of the triggers alone leaves it */
    running: string | null;
    flowName: string;
    warnings: string[];
    saved: boolean;
    workspace: string;
    flowId: string;
    /** the changed scripts the draft imports: they go in the same commit */
    scripts: string[];
    onCommit: (message: string, scripts: string[]) => Promise<ApiResult<FlowDeployments>>;
    onClose: () => void;
}) {
    const { branch, workspace, flowId, number, flowName, warnings, saved, scripts, onCommit, onClose } = props;
    const [before] = useState(props.running);
    const [message, setMessage] = useState(`Update ${flowName}`);
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<ApiResult<FlowDeployments> | null>(null);
    const commit = async () => {
        setBusy(true);
        setOutcome(await onCommit(message.trim(), scripts));
        setBusy(false);
    };
    const applied = outcome?.ok ? outcome.value : null;
    const deployedNow = applied ? deployedVersion(applied) : undefined;

    return (
        <Dialog open onOpenChange={isOpen => !isOpen && !busy && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Commit to {branch}</DialogTitle>
                    <DialogDescription>
                        {saved
                            ? `The draft goes to ${branch} as v${number}; the commit is deployed once it applies.`
                            : 'The draft could not be saved: what is pending is not committed.'}
                    </DialogDescription>
                </DialogHeader>
                {applied ? (
                    <div className="grid gap-3">
                        <p className="flex items-center gap-2 text-sm">
                            <CircleCheck className="size-4 text-emerald-600" />
                            {applied.commit ? (
                                <span>
                                    <span className="font-mono">{shortSha(applied.commit)}</span> applied
                                    {deployedNow &&
                                        (deployedNow.id === before
                                            ? ` · the version did not change, v${deployedNow.number} runs`
                                            : ` · v${deployedNow.number} deployed`)}
                                </span>
                            ) : (
                                'Nothing changed in the branch.'
                            )}
                        </p>
                        {applied.arrived && applied.arrived.length > 0 && (
                            <div className="grid gap-2">
                                <p className="text-sm text-muted-foreground">
                                    These triggers arrived disabled: none runs until it is turned on in this environment.
                                </p>
                                <ArrivedDisabledList handle={workspace} items={applied.arrived} className="max-h-[50vh] overflow-y-auto" />
                            </div>
                        )}
                    </div>
                ) : (
                    <>
                        <Input
                            aria-label="Commit message"
                            value={message}
                            disabled={busy}
                            onChange={e => setMessage(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && message.trim() && !busy && void commit()}
                            autoFocus
                        />
                        <CommitFiles workspace={workspace} flowId={flowId} scripts={scripts} />
                        {warnings.length > 0 && (
                            <div className="flex flex-col gap-1 text-sm text-amber-700 dark:text-amber-400">
                                {warnings.map(w => (
                                    <span key={w} className="flex gap-1.5">
                                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {w}
                                    </span>
                                ))}
                            </div>
                        )}
                        {outcome && !outcome.ok && (
                            <div className="grid gap-1 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
                                <span>{outcome.error.message}</span>
                                {Object.entries(outcome.error.fields ?? {}).map(([file, errors]) => (
                                    <span key={file} className="grid">
                                        <span className="font-mono text-xs">{file}</span>
                                        <span className="whitespace-pre-line text-xs">{errors}</span>
                                    </span>
                                ))}
                            </div>
                        )}
                    </>
                )}
                <DialogFooter>
                    {applied ? (
                        <Button onClick={onClose}>Close</Button>
                    ) : (
                        <>
                            <Button variant="outline" disabled={busy} onClick={onClose}>
                                Cancel
                            </Button>
                            <Button disabled={busy || !message.trim()} onClick={() => void commit()}>
                                {busy ? <LoaderCircle className="animate-spin" /> : <GitCommitHorizontal />}
                                {busy ? 'Committing…' : 'Commit'}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** the flow's versions, newest first: which one is deployed, deploy or roll back to one, restore the draft from one */
export function VersionsDialog(props: {
    open: boolean;
    onClose: () => void;
    deployments: FlowDeployments;
    busy: boolean;
    /** absent: versions cannot be deployed from here (an environment that only takes pull requests) */
    onSwitch?: (version: FlowVersion) => void;
    onEmergencyRollback?: (version: FlowVersion) => void;
    onEndEmergencyRollback?: () => void;
    onRestore: (version: FlowVersion) => void;
}) {
    const { open, onClose, deployments, busy, onSwitch, onEmergencyRollback, onEndEmergencyRollback, onRestore } = props;
    const deployed = deployedVersion(deployments);

    return (
        <Dialog open={open} onOpenChange={isOpen => !isOpen && onClose()}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Versions</DialogTitle>
                </DialogHeader>
                <ul className="max-h-96 divide-y overflow-y-auto rounded-md border">
                    {deployments.versions.map(version => {
                        const isDeployed = version.id === deployed?.id;
                        const action = switchAction(deployments, version);
                        return (
                            <li key={version.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                                <span className="w-10 font-mono font-medium">v{version.number}</span>
                                <span className="grid min-w-40 flex-1 basis-40 text-muted-foreground">
                                    {version.commit && (
                                        <span className="truncate text-foreground" title={version.commitMessage}>
                                            <span className="font-mono text-xs text-muted-foreground">{shortSha(version.commit)}</span>{' '}
                                            {version.commitMessage}
                                        </span>
                                    )}
                                    <span className="truncate" title={formatDateTime(version.createdAt)}>
                                        {relativeTime(version.createdAt)}
                                        {version.createdByName && ` · ${version.createdByName}`}
                                    </span>
                                </span>
                                <span className="ml-auto flex shrink-0 items-center gap-1">
                                    {version.emergencyRollbackOffer === 'end' && onEndEmergencyRollback && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={busy}
                                            onClick={onEndEmergencyRollback}
                                            title="This is git's content: going back to it ends the emergency rollback"
                                        >
                                            <Undo2 /> End the emergency rollback
                                        </Button>
                                    )}
                                    {version.emergencyRollbackOffer === 'roll-back' && onEmergencyRollback && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={busy}
                                            onClick={() => onEmergencyRollback(version)}
                                            title="Run this version here now, without a commit"
                                        >
                                            <TriangleAlert /> Emergency rollback
                                        </Button>
                                    )}
                                    {isDeployed ? (
                                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                                            {deployments.emergencyRollback ? 'Runs here' : 'Deployed'}
                                        </span>
                                    ) : version.emergencyRollbackOffer === 'end' ? null : (
                                        <Button variant="ghost" size="sm" disabled={busy || !onSwitch} onClick={() => onSwitch?.(version)}>
                                            {action === 'rollback' ? <Undo2 /> : deployments.git ? <GitCommitHorizontal /> : <Rocket />}
                                            {action === 'rollback'
                                                ? deployments.git
                                                    ? 'Revert'
                                                    : 'Roll back'
                                                : deployments.git
                                                  ? 'Commit'
                                                  : 'Deploy'}
                                        </Button>
                                    )}
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => onRestore(version)}
                                        title="Replace the draft by this version"
                                    >
                                        <RotateCcw /> Restore draft
                                    </Button>
                                </span>
                            </li>
                        );
                    })}
                </ul>
                {deployments.history.length > 0 && (
                    <>
                        <h3 className="text-sm font-medium">History</h3>
                        <ul className="max-h-48 divide-y overflow-y-auto rounded-md border">
                            {deployments.history.map((event, i) => (
                                <li key={i} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                                    <span className="min-w-0 flex-1 truncate">
                                        {eventText(event)}
                                        {event.commit && event.action !== 'end-emergency-rollback' && (
                                            <span className="font-mono text-xs text-muted-foreground"> · {shortSha(event.commit)}</span>
                                        )}
                                    </span>
                                    <span className="shrink-0 text-xs text-muted-foreground" title={formatDateTime(event.at)}>
                                        {relativeTime(event.at)}
                                        {(event.byName ?? event.by) && ` · ${event.byName ?? event.by}`}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

/** a component as the Compare names it: its label, or its kind */
const nodeName = (n: ComparedNode) => (n.label && n.label !== n.type ? n.label : (componentInfo(n.type)?.label ?? n.type));

/** what the draft changes in the deployed version, by what the engine takes (positions, notes, groups do not count) */
export function CompareDialog({ onClose, version, draft }: { onClose: () => void; version: FlowVersion; draft: FlowFile | null }) {
    const changes = draft ? flowChanges(version.definition, draft) : null;
    const nodes = new Map([...version.definition.nodes, ...(draft?.nodes ?? [])].map(n => [n.id, n]));
    const name = (id: string) => {
        const n = nodes.get(id);
        return n ? nodeName({ id, type: n.type, label: n.label || n.type }) : id;
    };
    const none =
        changes &&
        !changes.added.length &&
        !changes.removed.length &&
        !changes.changed.length &&
        !changes.edgesAdded.length &&
        !changes.edgesRemoved.length;
    const section = (title: string, items: string[], tone: string) =>
        items.length > 0 && (
            <div className="grid gap-1">
                <h3 className="text-sm font-medium">{title}</h3>
                <ul className="grid gap-0.5 rounded-md border px-3 py-2 text-sm">
                    {items.map((item, i) => (
                        <li key={i} className={cn('truncate', tone)}>
                            {item}
                        </li>
                    ))}
                </ul>
            </div>
        );

    return (
        <Dialog open onOpenChange={isOpen => !isOpen && onClose()}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>Draft vs v{version.number}</DialogTitle>
                </DialogHeader>
                <div className="grid max-h-[60vh] gap-3 overflow-y-auto">
                    {none && <p className="text-sm text-muted-foreground">No changes.</p>}
                    {changes && (
                        <>
                            {section('Added', changes.added.map(nodeName), 'text-emerald-700 dark:text-emerald-400')}
                            {section('Removed', changes.removed.map(nodeName), 'text-red-700 dark:text-red-400')}
                            {section(
                                'Changed',
                                changes.changed.map(n => `${nodeName(n)}: ${n.fields.map(f => f.replace(/^config\./, '')).join(', ')}`),
                                'text-amber-700 dark:text-amber-400',
                            )}
                            {section(
                                'Connections added',
                                changes.edgesAdded.map(e => `${name(e.source)} → ${name(e.target)}`),
                                'text-emerald-700 dark:text-emerald-400',
                            )}
                            {section(
                                'Connections removed',
                                changes.edgesRemoved.map(e => `${name(e.source)} → ${name(e.target)}`),
                                'text-red-700 dark:text-red-400',
                            )}
                        </>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
