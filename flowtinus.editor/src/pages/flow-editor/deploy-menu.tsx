import { useEffect, useMemo, useState } from 'react';
import { CircleOff, GitCompareArrows, History, LoaderCircle, Rocket, RotateCcw, TriangleAlert, Undo2, Upload } from 'lucide-react';
import { flowChanges, type ComparedNode, type FlowFile } from '@flowtinus/core';
import { componentInfo } from '@/editor/catalog';
import type { ConfirmTarget } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { deployedVersion, deployState, eventText, nextNumber, NO_DEPLOYMENTS, switchAction, type DeployState, type FlowDeployments, type FlowVersion } from '@/data/deployments/deployment';
import { deployFlow, deployVersion, getDeployments, restoreDraft, undeployFlow } from '@/data/deployments/deployments-api';
import type { FlushResult } from '@/editor/flow-save';
import type { ApiResult } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { relativeTime } from '@/lib/relative-time';
import { cn } from '@/lib/utils';

/** the chip on the Deploy button */
export function DeployBadge({ state }: { state: DeployState }) {
    if (state.kind === 'not-deployed') {
        return <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Not deployed</span>;
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
export function DeployMenu({ flowId, environment, disabled, draftNow, saveMark, flush, onDraftReplaced, confirm, onDeployed }: Props) {
    const [deployments, setDeployments] = useState<{ flowId: string; value: FlowDeployments } | null>(null);
    const [busy, setBusy] = useState(false);
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [compareOpen, setCompareOpen] = useState(false);
    const current = deployments?.flowId === flowId ? deployments.value : NO_DEPLOYMENTS;

    useEffect(() => {
        let gone = false;
        void getDeployments(flowId).then(result => !gone && result.ok && setDeployments({ flowId, value: result.value }));
        return () => {
            gone = true;
        };
    }, [flowId]);

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
    const act = async (action: () => Promise<ApiResult<FlowDeployments>>): Promise<ApiResult<unknown>> => {
        setBusy(true);
        const result = await action();
        setBusy(false);
        if (result.ok) {
            setDeployments({ flowId, value: result.value });
        }

        return result;
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
        confirm({
            title: `Deploy v${nextNumber(latest)} to ${environment}?`,
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
        confirm({
            title: action === 'rollback' ? `Roll back to v${version.number}?` : `Deploy v${version.number} to ${environment}?`,
            description: deployed ? `Replaces v${deployed.number}.` : `Nothing is deployed now.`,
            confirmLabel: action === 'rollback' ? 'Roll back' : 'Deploy',
            busyLabel: action === 'rollback' ? 'Rolling back…' : 'Deploying…',
            destructive: action === 'rollback',
            onConfirm: () => act(() => deployVersion(flowId, version.id)),
        });
    };

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
            title: `Undeploy from ${environment}?`,
            description: deployed ? `v${deployed.number} stops being deployed. Its versions are kept.` : '',
            confirmLabel: 'Undeploy',
            busyLabel: 'Undeploying…',
            destructive: true,
            onConfirm: () => act(() => undeployFlow(flowId)),
        });

    const nothingToDeploy = state.kind === 'deployed' && !state.changed;

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="bg-card shadow-md" disabled={disabled} aria-label="Deploy">
                        {busy ? <LoaderCircle className="animate-spin" /> : <Rocket />} Deploy
                        <DeployBadge state={state} />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                    <DropdownMenuLabel className="font-normal text-muted-foreground">
                        {deployed && current.deployed ? (
                            <>
                                <span className="font-medium text-foreground">v{deployed.number}</span> in {environment} ·{' '}
                                <span title={formatDateTime(current.deployed.deployedAt)}>{relativeTime(current.deployed.deployedAt)}</span>
                                {current.deployed.deployedByName && ` · ${current.deployed.deployedByName}`}
                            </>
                        ) : (
                            `Not deployed in ${environment}`
                        )}
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={busy || nothingToDeploy} onSelect={() => void deploy()}>
                        <Upload /> Deploy draft as v{nextNumber(current)}
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
                    <DropdownMenuItem variant="destructive" disabled={busy || !deployed} onSelect={undeploy}>
                        <CircleOff /> Undeploy
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <VersionsDialog
                open={versionsOpen}
                onClose={() => setVersionsOpen(false)}
                deployments={current}
                busy={busy}
                onSwitch={switchTo}
                onRestore={restore}
            />
            {deployed && compareOpen && <CompareDialog onClose={() => setCompareOpen(false)} version={deployed} draft={draftNow()} />}
        </>
    );
}

/** the flow's versions, newest first: which one is deployed, deploy or roll back to one, restore the draft from one */
export function VersionsDialog(props: {
    open: boolean;
    onClose: () => void;
    deployments: FlowDeployments;
    busy: boolean;
    onSwitch: (version: FlowVersion) => void;
    onRestore: (version: FlowVersion) => void;
}) {
    const { open, onClose, deployments, busy, onSwitch, onRestore } = props;
    const deployed = deployedVersion(deployments);

    return (
        <Dialog open={open} onOpenChange={isOpen => !isOpen && onClose()}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>Versions</DialogTitle>
                </DialogHeader>
                <ul className="max-h-96 divide-y overflow-y-auto rounded-md border">
                    {deployments.versions.map(version => {
                        const isDeployed = version.id === deployed?.id;
                        const action = switchAction(deployments, version);
                        return (
                            <li key={version.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                                <span className="w-10 font-mono font-medium">v{version.number}</span>
                                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={formatDateTime(version.createdAt)}>
                                    {relativeTime(version.createdAt)}
                                    {version.createdByName && ` · ${version.createdByName}`}
                                </span>
                                {isDeployed ? (
                                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                                        Deployed
                                    </span>
                                ) : (
                                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => onSwitch(version)}>
                                        {action === 'rollback' ? <Undo2 /> : <Rocket />}
                                        {action === 'rollback' ? 'Roll back' : 'Deploy'}
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
                                    <span className="min-w-0 flex-1 truncate">{eventText(event)}</span>
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
