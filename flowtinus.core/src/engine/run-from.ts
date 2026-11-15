import type { ComponentRun } from '#types/component-run.type';
import type { EnvelopeData } from '#types/envelope-data.type';
import type { ExecutableFlow } from '#types/executable-flow.type';
import type { ExecutableNode } from '#types/executable-node.type';
import type { RunMode } from '#types/run-mode.type';

/*
 * Pins and Run from here. A pinned node (test runs) does not need its input: what only feeds pinned nodes is skipped.
 * Run from here runs one component and what comes after it: the envelopes that reached it in the last run go straight
 * into its inputs. Nothing before it runs; an input of a later component fed from outside that part gets nothing.
 */

const replays = (node: ExecutableNode, mode: RunMode) => mode === 'validation' && Boolean(node.pinned);

export function skippedNodes(wf: ExecutableFlow, mode: RunMode): Set<string> {
    const byId = new Map(wf.nodes.map(n => [n.id, n]));
    const targets = new Map<string, string[]>(wf.nodes.map(n => [n.id, []]));
    for (const e of wf.edges) {
        targets.get(e.source)?.push(e.target);
    }
    const needed = new Set<string>();
    for (let grew = true; grew;) {
        grew = false;
        for (const node of wf.nodes) {
            if (needed.has(node.id)) {
                continue;
            }
            const out = targets.get(node.id) ?? [];
            const feedsOne = out.some(t => needed.has(t) && !replays(byId.get(t)!, mode));
            if (out.length === 0 || feedsOne) {
                needed.add(node.id);
                grew = true;
            }
        }
    }
    return new Set(wf.nodes.filter(n => !needed.has(n.id)).map(n => n.id));
}

export function downstreamOf(edges: ExecutableFlow['edges'], nodeId: string): Set<string> {
    const part = new Set([nodeId]);
    for (let grew = true; grew;) {
        grew = false;
        for (const e of edges) {
            if (part.has(e.source) && !part.has(e.target)) {
                part.add(e.target);
                grew = true;
            }
        }
    }
    return part;
}

export type RunFromPlan = {
    nodeId: string;
    label: string;
    inputs: Record<string, EnvelopeData[]>;
    totals: Record<string, number>;
};

export function planRunFrom(
    wf: ExecutableFlow,
    nodeId: string,
    last: ComponentRun[],
): { ok: true; plan: RunFromPlan } | { ok: false; error: string } {
    const node = wf.nodes.find(n => n.id === nodeId);
    if (!node) {
        return { ok: false, error: 'The component is not in the flow.' };
    }
    if (node.loop !== undefined) {
        return {
            ok: false,
            error: `Run from here is not offered inside a Loop: "${node.label}" runs only in its iterations. Run from the Loop instead.`,
        };
    }
    const ran = last.find(c => c.nodeId === nodeId);
    const totals = Object.fromEntries(Object.entries(ran?.inputs ?? {}).filter(([, n]) => n > 0));
    if (!ran || Object.keys(totals).length === 0) {
        return { ok: false, error: `Nothing reached "${node.label}" in the last run: run the flow first.` };
    }

    // a run that ended without its worker has the samples of its last progress, which may leave big envelopes out
    if ((ran.samplesNotKept?.input ?? 0) > 0) {
        return {
            ok: false,
            error: `The last run did not keep what reached "${node.label}" (envelopes too big for its record): run the flow first.`,
        };
    }
    const ports = Object.keys(totals);
    const inputs = ran.inputSampleByPort
        ? Object.fromEntries(ports.map(p => [p, ran.inputSampleByPort![p] ?? []]))
        : { [ports[0]!]: ran.inputSample };
    return { ok: true, plan: { nodeId, label: node.label, inputs, totals } };
}

export function applyRunFrom(wf: ExecutableFlow, plan: RunFromPlan): ExecutableFlow {
    const part = downstreamOf(wf.edges, plan.nodeId);
    return {
        ...wf,
        nodes: wf.nodes.filter(n => part.has(n.id)),
        edges: wf.edges.filter(e => part.has(e.source) && part.has(e.target)),
    };
}

export function pinnedFromRun(
    run: Pick<ComponentRun, 'outputs' | 'outputSample'>,
    port?: string,
): { ok: true; pinned: Record<string, EnvelopeData[]>; missing: number } | { ok: false; error: string } {
    const ports = port === undefined ? Object.keys(run.outputSample) : [port];
    if (port !== undefined && !run.outputSample[port]?.length) {
        const kept = Object.entries(run.outputSample)
            .filter(([, items]) => items.length > 0)
            .map(([p]) => p);
        return {
            ok: false,
            error: `Nothing went out of the port ${port} in that run${kept.length ? ` (the record has envelopes of ${kept.join(', ')})` : ''}.`,
        };
    }
    if (!ports.some(p => run.outputSample[p]?.length)) {
        return { ok: false, error: 'Nothing went out of the component in that run: there is nothing to pin.' };
    }
    const pinned = Object.fromEntries(ports.map(p => [p, structuredClone(run.outputSample[p] ?? [])]));
    const missing = ports.reduce((n, p) => n + Math.max(0, (run.outputs[p] ?? 0) - (run.outputSample[p]?.length ?? 0)), 0);
    return { ok: true, pinned, missing };
}

export function withoutPins<N extends { id: string; pinned?: unknown }>(
    nodes: N[],
    nodeIds: string[],
): { nodes: N[]; unpinned: string[]; notPinned: string[]; notFound: string[] } {
    const wanted = new Set(nodeIds);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const unpinned = [...wanted].filter(id => byId.get(id)?.pinned !== undefined);
    const notPinned = [...wanted].filter(id => byId.has(id) && byId.get(id)!.pinned === undefined);
    const notFound = [...wanted].filter(id => !byId.has(id));
    return {
        nodes: nodes.map(n => {
            if (!wanted.has(n.id) || n.pinned === undefined) {
                return n;
            }
            const { pinned: _pinned, ...rest } = n;
            return rest as N;
        }),
        unpinned,
        notPinned,
        notFound,
    };
}
