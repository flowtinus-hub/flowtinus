import { useEffect, type ReactNode } from 'react';
import { CircleAlert, ExternalLink, FileCode2, GitFork } from 'lucide-react';
import { flowPath, scriptPath } from '@/app/paths';
import { callPath, callTree, MAX_FLOW_DEPTH, type CallTreeNode, type FlowCall, type ScriptUse } from '@flowtinus/core';
import { Button } from '@/components/ui/button';
import type { FlowCalls } from '@/data/flows/flows-api';
import { loadProjectCalls, useProjectCalls, withOwnCalls } from '@/editor/project-calls';
import { cn } from '@/lib/utils';
import { useWorkspaceHandle } from '@/data/workspaces/use-workspace';

type Named = FlowCalls['flows'][number];

/**
 * The flows this flow calls (its Flow Invokers, and theirs, down the chain) and the ones that call it, in the canvas's
 * tools before Group: "Calls 2 · Called by 1", a circle in red when a chain comes back to it; a click (or D) opens the
 * panel under it. This flow's own calls are the canvas's as they are now (`own`: it updates as a Flow Invoker is added,
 * removed or changed); the other flows' are read again each time it opens.
 */
export function FlowCallsPanel({
    projectId,
    flowId,
    own,
    ownScripts,
    onFocus,
    open,
    onToggle,
}: {
    projectId: string;
    flowId: string;
    own: FlowCall[] | null;
    /** the scripts the canvas's components import now */
    ownScripts: ScriptUse[] | null;
    /** selects one of this flow's components in the canvas (a click on it in the panel) */
    onFocus?: (nodeId: string) => void;
    open: boolean;
    onToggle: () => void;
}) {
    const data = useProjectCalls(projectId);
    useEffect(() => {
        if (open) {
            loadProjectCalls(projectId, true);
        }
    }, [open, projectId]);
    const calls = withOwnCalls(data?.calls ?? [], flowId, own);
    const uses = calls.filter(c => c.from === flowId);
    const usedBy = calls.filter(c => c.to === flowId && c.from !== flowId);
    const circular = uses.some(c => c.to === flowId || callPath(calls, c.to, flowId));
    const scriptUses = ownScripts ?? (data?.scriptUses ?? []).filter(u => u.from === flowId);
    const scriptCount = new Set(scriptUses.map(u => u.path)).size;
    return (
        <div className="relative">
            <Button
                variant="outline"
                size="sm"
                className={cn('bg-card shadow-md', open && 'bg-accent')}
                aria-expanded={open}
                onClick={onToggle}
                title={
                    circular
                        ? 'A chain of calls comes back to this flow: those calls fail (D)'
                        : 'The flows it calls, the ones that call it and the scripts it imports (D)'
                }
            >
                <GitFork className={cn(circular && 'text-destructive')} />
                <span className="font-mono text-xs">
                    Calls {data ? new Set(uses.map(c => c.to)).size : '…'} · Called by {data ? new Set(usedBy.map(c => c.from)).size : '…'}{' '}
                    · Scripts {data ? scriptCount : '…'}
                </span>
                {circular && <CircleAlert className="text-destructive" aria-label="circular call" />}
            </Button>
            {open && (
                <div className="absolute top-full left-0 z-10 mt-2 max-h-[60vh] w-[28rem] max-w-[calc(100vw-2rem)] overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-md">
                    {data ? (
                        <FlowCallsView
                            projectId={projectId}
                            flowId={flowId}
                            data={data}
                            calls={calls}
                            scriptUses={scriptUses}
                            onFocus={onFocus}
                        />
                    ) : (
                        <p className="text-muted-foreground">Reading the calls…</p>
                    )}
                </div>
            )}
        </div>
    );
}

/** what the panel shows: the call tree (Calls) and the callers (Called by) */
export function FlowCallsView({
    projectId,
    flowId,
    data,
    calls,
    scriptUses,
    onFocus,
}: {
    projectId: string;
    flowId: string;
    data: FlowCalls;
    calls: FlowCall[];
    scriptUses: ScriptUse[];
    onFocus?: Focus;
}) {
    const byId = new Map(data.flows.map(f => [f.id, f]));
    const nameOf = (id: string) => byId.get(id)?.name ?? 'Not found';
    const tree = callTree(calls, flowId);
    const callers = calls.filter(c => c.to === flowId && c.from !== flowId);
    return (
        <div className="grid gap-3">
            <section className="grid gap-1">
                <h3 className="flex items-center justify-between font-medium">
                    Calls
                    <span className="text-xs font-normal text-muted-foreground">up to {MAX_FLOW_DEPTH} levels</span>
                </h3>
                {tree.nodes.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No Flow Invoker calls another flow.</p>
                ) : (
                    <CallRows nodes={tree.nodes} projectId={projectId} byId={byId} nameOf={nameOf} onFocus={onFocus} />
                )}
                {tree.truncated && <p className="text-xs text-muted-foreground">Cut short: too many calls to show.</p>}
            </section>
            <section className="grid gap-1">
                <h3 className="font-medium">Called by</h3>
                {callers.length === 0 && <p className="text-xs text-muted-foreground">No flow calls this one.</p>}
                <ul aria-label="Called by" className="grid min-w-0 gap-0.5">
                    {callers.map(c => (
                        <li key={`${c.from}:${c.nodeId}`} className="min-w-0">
                            <FlowLink
                                projectId={projectId}
                                flow={byId.get(c.from)}
                                id={c.from}
                                detail={`via ${c.nodeLabel}${c.onErrorOfLabel ? ` · on error of ${c.onErrorOfLabel}` : ''}`}
                            />
                        </li>
                    ))}
                </ul>
            </section>
            <ScriptsSection projectId={projectId} data={data} uses={scriptUses} onFocus={onFocus} />
        </div>
    );
}

/** a component of this flow: a click selects it in the canvas, in the middle of the screen */
type Focus = (nodeId: string) => void;

/** "via A, B": the components of this flow that make the link, each a button to it in the canvas (when `onFocus`) */
function Via({ parts, onFocus }: { parts: { nodeId: string; label: string; note?: string }[]; onFocus?: Focus }) {
    return (
        <>
            via{' '}
            {parts.map((part, i) => (
                <span key={`${part.nodeId}:${part.note ?? ''}`}>
                    {i > 0 && ', '}
                    {onFocus ? (
                        <button
                            type="button"
                            className="text-foreground underline-offset-2 hover:underline"
                            title={`Show ${part.label} in the canvas`}
                            onClick={() => onFocus(part.nodeId)}
                        >
                            {part.label}
                        </button>
                    ) : (
                        part.label
                    )}
                    {part.note && ` ${part.note}`}
                </span>
            ))}
        </>
    );
}

/** the scripts this flow's components import, and what those import in turn (each once, a cycle cut where it closes) */
function ScriptsSection({ projectId, data, uses, onFocus }: { projectId: string; data: FlowCalls; uses: ScriptUse[]; onFocus?: Focus }) {
    const known = new Set(data.scripts);
    const importsOf = (path: string) => [...new Set(data.scriptImports.filter(i => i.from === path).map(i => i.to))].sort();
    const direct = new Map<string, ScriptUse[]>();
    for (const use of uses) {
        direct.set(use.path, [...(direct.get(use.path) ?? []), use]);
    }
    const rows = (path: string, depth: number, seen: Set<string>): ReactNode => {
        const children = seen.has(path) ? [] : importsOf(path);
        const next = new Set(seen).add(path);
        return children.map(child => (
            <li key={`${path}>${child}`} className="min-w-0" style={{ paddingLeft: `${depth}rem` }}>
                <ScriptLink projectId={projectId} path={child} known={known.has(child)} detail={<>imported by {path}</>} />
                {!next.has(child) && <ul className="grid min-w-0 gap-0.5">{rows(child, depth + 1, next)}</ul>}
            </li>
        ));
    };
    return (
        <section className="grid min-w-0 gap-1">
            <h3 className="font-medium">Scripts</h3>
            {direct.size === 0 && <p className="text-xs text-muted-foreground">No component imports a script.</p>}
            <ul aria-label="Scripts" className="grid min-w-0 gap-0.5">
                {[...direct]
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([path, by]) => (
                        <li key={path} className="min-w-0">
                            <ScriptLink
                                projectId={projectId}
                                path={path}
                                known={known.has(path)}
                                detail={
                                    <Via
                                        parts={by.map(u => ({
                                            nodeId: u.nodeId,
                                            label: u.nodeLabel,
                                            ...(u.how === 'type' ? { note: '(types)' } : {}),
                                        }))}
                                        onFocus={onFocus}
                                    />
                                }
                            />
                            <ul className="grid min-w-0 gap-0.5">{rows(path, 1, new Set())}</ul>
                        </li>
                    ))}
            </ul>
        </section>
    );
}

/** a script: its name opens it in the Scripts tab in a new tab; one the project does not have is not a link */
function ScriptLink({ projectId, path, known, detail }: { projectId: string; path: string; known: boolean; detail: ReactNode }) {
    const ws = useWorkspaceHandle();
    const name = (
        <span className="flex min-w-0 items-center gap-2">
            <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className={cn('truncate font-mono text-xs font-medium', !known && 'text-destructive')}>{path}</span>
            {known && (
                <ExternalLink className="ml-auto size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" aria-hidden />
            )}
        </span>
    );
    return (
        <div className="group flex min-w-0 flex-col rounded px-2 py-1 hover:bg-accent">
            {known ? (
                <a
                    href={scriptPath(ws, projectId, path)}
                    target="_blank"
                    rel="noopener"
                    title={`Open ${path} in a new tab`}
                    className="min-w-0"
                >
                    {name}
                </a>
            ) : (
                name
            )}
            <span className={cn('truncate pl-5.5 text-xs text-muted-foreground', !known && 'text-destructive')}>
                {!known && 'Not found: the import fails · '}
                {detail}
            </span>
        </div>
    );
}

function CallRows({
    nodes,
    projectId,
    byId,
    nameOf,
    onFocus,
}: {
    nodes: CallTreeNode[];
    projectId: string;
    byId: Map<string, Named>;
    nameOf: (id: string) => string;
    onFocus?: Focus;
}) {
    return (
        <ul className="grid min-w-0 gap-0.5">
            {nodes.map(node => {
                const { call } = node;
                // only the first level's Flow Invokers are on this canvas
                const via = (
                    <Via parts={[{ nodeId: call.nodeId, label: call.nodeLabel }]} onFocus={node.depth === 1 ? onFocus : undefined} />
                );
                return (
                    <li key={`${call.from}:${call.nodeId}`} className="min-w-0" style={{ paddingLeft: `${(node.depth - 1) * 1}rem` }}>
                        <FlowLink
                            projectId={projectId}
                            flow={byId.get(call.to)}
                            id={call.to}
                            detail={
                                <>
                                    {via}
                                    {call.onErrorOfLabel && ` · on error of ${call.onErrorOfLabel}`}
                                </>
                            }
                            depth={node.depth}
                        >
                            {node.cycle && <span className="text-destructive">Circular: back to {nameOf(call.to)}; each call fails</span>}
                            {node.tooDeep && <span className="text-destructive">Past {MAX_FLOW_DEPTH} levels: the call fails</span>}
                        </FlowLink>
                        {node.children.length > 0 && <CallRows nodes={node.children} projectId={projectId} byId={byId} nameOf={nameOf} />}
                    </li>
                );
            })}
        </ul>
    );
}

/**
 * A flow on the other end of a call: its name opens it in a new tab (a middle click too), with its folder and how it is
 * called; a removed one is not a link, an archived one says so.
 */
function FlowLink(props: {
    projectId: string;
    flow: Named | undefined;
    id: string;
    detail: ReactNode;
    depth?: number;
    children?: ReactNode;
}) {
    const ws = useWorkspaceHandle();
    const { projectId, flow, id, detail, depth, children } = props;
    const where = flow ? (flow.available ? flow.folder || 'Flows (root)' : 'Archived: each call fails') : 'Removed: each call fails';
    const name = (
        <span className="flex min-w-0 items-center gap-2">
            {depth !== undefined && depth > 1 && <span className="font-mono text-xs text-muted-foreground">{depth}</span>}
            <span
                className={cn(
                    'truncate font-medium',
                    !flow && 'text-destructive',
                    flow && !flow.available && 'text-muted-foreground line-through',
                )}
                title={flow ? undefined : id}
            >
                {flow?.name ?? 'Not found'}
            </span>
            {flow && (
                <ExternalLink className="ml-auto size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" aria-hidden />
            )}
        </span>
    );
    return (
        <div className="group flex min-w-0 flex-col rounded px-2 py-1 hover:bg-accent">
            {flow ? (
                <a
                    href={flowPath(ws, projectId, id)}
                    target="_blank"
                    rel="noopener"
                    title={`Open ${flow.name} in a new tab`}
                    className="min-w-0"
                >
                    {name}
                </a>
            ) : (
                name
            )}
            <span className={cn('truncate text-xs text-muted-foreground', (!flow || !flow.available) && 'text-destructive')}>
                {where} · {detail}
            </span>
            {children && <span className="text-xs">{children}</span>}
        </div>
    );
}
