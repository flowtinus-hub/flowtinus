import { END, ITERATION_END, ITERATION_START, LOOP, LOOP_CONTROLS, START } from '#engine/constants';
import { isInnerPort, type PortEdge } from './ports';

/*
 * Loop regions (GLOSSARY, Loops; ADR 0001): a node inside a Loop's region names it in `loop`. The region is closed:
 * an edge joins two nodes of the same region, where a Loop's inner ports (Iteration start, Iteration end) count as
 * inside its region and its input and output as outside it.
 */

export type RegionNode = { id: string; type: string; loop?: string };

/** the region an edge's end is in: a Loop's inner port is inside that Loop; any other port is where its node is */
function sideOf(nodes: Map<string, RegionNode>, id: string, side: 'source' | 'target', port: string): string | undefined {
    const node = nodes.get(id);
    return isInnerPort(node?.type, side, port) ? id : node?.loop;
}

/** whether an edge joins two regions (a loop region is closed) */
export function crossesRegion(edge: PortEdge, nodes: RegionNode[]): boolean {
    const byId = new Map(nodes.map(n => [n.id, n]));
    return sideOf(byId, edge.source, 'source', edge.sourcePort) !== sideOf(byId, edge.target, 'target', edge.targetPort);
}

/**
 * The flow's graph for the cycle check: a Loop's inner ports stand as nodes of their own, so Iteration start → … →
 * Iteration end is a path inside its region, not a cycle through the Loop.
 */
export function cycleGraph(nodes: RegionNode[], edges: PortEdge[]): { ids: string[]; edges: { source: string; target: string }[] } {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const loops = nodes.filter(n => n.type === LOOP).map(n => n.id);
    const end = (id: string, side: 'source' | 'target', port: string) =>
        isInnerPort(byId.get(id)?.type, side, port) ? `${id}\n${port}` : id;
    return {
        ids: [...nodes.map(n => n.id), ...loops.flatMap(id => [`${id}\n${ITERATION_START}`, `${id}\n${ITERATION_END}`])],
        edges: edges.map(e => ({ source: end(e.source, 'source', e.sourcePort), target: end(e.target, 'target', e.targetPort) })),
    };
}

/** the flow's node a node of the cycle graph stands for (an inner port: its Loop) */
export const cycleNodeId = (id: string): string => id.split('\n')[0]!;

/** a node of the cycle graph by its name: an inner port is its Loop's name and the port's */
export function cycleNodeName(id: string, name: (nodeId: string) => string): string {
    const [nodeId, port] = id.split('\n') as [string, string | undefined];
    return port ? `${name(nodeId)} (${port === ITERATION_START ? 'Iteration start' : 'Iteration end'})` : name(nodeId);
}

/**
 * What is wrong with the flow's loop regions: a Continue with, Next or Break outside every Loop, a `loop` that names no Loop, a
 * Start or End inside a Loop, a Loop inside itself (directly or through others), an edge between two regions.
 */
export function loopRegionIssues(nodes: RegionNode[], edges: PortEdge[]): { nodeId: string; message: string }[] {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const issues: { nodeId: string; message: string }[] = [];
    for (const node of nodes) {
        if (node.loop === undefined) {
            if (LOOP_CONTROLS.includes(node.type)) {
                issues.push({
                    nodeId: node.id,
                    message: 'is outside every Loop: a Continue with, Next or Break works only inside a Loop.',
                });
            }
            continue;
        }
        if (node.type === START || node.type === END) {
            issues.push({
                nodeId: node.id,
                message: `is inside the Loop "${node.loop}": the flow's Start and End are never inside a Loop.`,
            });
            continue;
        }
        if (byId.get(node.loop)?.type !== LOOP) {
            issues.push({ nodeId: node.id, message: `names "${node.loop}" as its Loop, but that is not a Loop of the flow.` });
            continue;
        }
        // a node held by Loops that hold each other is not blamed: those Loops are
        const seen = new Set<string>();
        for (let at = byId.get(node.loop); at && !seen.has(at.id); at = at.loop === undefined ? undefined : byId.get(at.loop)) {
            if (at.id === node.id) {
                issues.push({ nodeId: node.id, message: 'is inside itself: its loop goes around back to it.' });
                break;
            }
            seen.add(at.id);
        }
    }
    for (const e of edges) {
        if (byId.has(e.source) && byId.has(e.target) && crossesRegion(e, nodes)) {
            issues.push({
                nodeId: e.source,
                message: `has an edge to "${e.target}" across a Loop's region: a loop region is closed (nothing inside a Loop connects to anything outside it).`,
            });
        }
    }
    return issues;
}
