import { END, ITERATION_END, ITERATION_START, START } from '#engine/constants';
import { isInnerPort } from '#validation/ports';
import type { ExecutableEdge } from '#types/executable-edge.type';
import type { ExecutableFlow } from '#types/executable-flow.type';

/**
 * The part of a flow one execution runs (ADR 0002). The root: the nodes outside every Loop, and their edges (a Loop's
 * inner ports belong to its region). A Loop's region: its nodes as an inner flow of their own, with a Start where
 * Iteration start is and an End where Iteration end is, built anew for each iteration.
 */
export function regionFlow(wf: ExecutableFlow, loopId?: string): ExecutableFlow {
    const typeOf = new Map(wf.nodes.map(n => [n.id, n.type]));
    const inRegion = new Set(wf.nodes.filter(n => n.loop === loopId).map(n => n.id));
    const innerSource = (e: ExecutableEdge) => isInnerPort(typeOf.get(e.source), 'source', e.sourcePort);
    const innerTarget = (e: ExecutableEdge) => isInnerPort(typeOf.get(e.target), 'target', e.targetPort);
    // a Loop inside this region keeps its inner ports' edges to its own region
    const ownSource = (e: ExecutableEdge) => inRegion.has(e.source) && !innerSource(e);
    const ownTarget = (e: ExecutableEdge) => inRegion.has(e.target) && !innerTarget(e);
    if (loopId === undefined) {
        if (inRegion.size === wf.nodes.length && !wf.edges.some(e => innerSource(e) || innerTarget(e))) {
            return wf;
        }
        return { ...wf, nodes: wf.nodes.filter(n => inRegion.has(n.id)), edges: wf.edges.filter(e => ownSource(e) && ownTarget(e)) };
    }

    const start = `${loopId}:${ITERATION_START}`;
    const end = `${loopId}:${ITERATION_END}`;
    const fromStart = (e: ExecutableEdge) => e.source === loopId && innerSource(e);
    const toEnd = (e: ExecutableEdge) => e.target === loopId && innerTarget(e);
    return {
        ...wf,
        nodes: [
            { id: start, type: START, label: 'Iteration start', config: {} },
            ...wf.nodes.filter(n => inRegion.has(n.id)),
            { id: end, type: END, label: 'Iteration end', config: {} },
        ],
        edges: wf.edges
            .filter(e => (fromStart(e) || ownSource(e)) && (toEnd(e) || ownTarget(e)))
            .map(e => ({
                source: fromStart(e) ? start : e.source,
                sourcePort: fromStart(e) ? 'out-0' : e.sourcePort,
                target: toEnd(e) ? end : e.target,
                targetPort: toEnd(e) ? 'in-0' : e.targetPort,
            })),
    };
}
