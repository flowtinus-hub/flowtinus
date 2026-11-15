import { COMPONENTS } from '../components';
import { END, ITERATION_END, ITERATION_START, LOOP, START } from '#engine/constants';
import type { ErrorPolicy } from '#types/error-policy.type';

export type PortInfo = { id: string; label?: string; optional?: boolean; single?: boolean; inner?: boolean };

const LOOP_INPUTS: PortInfo[] = [
    { id: 'in-0', single: true },
    { id: ITERATION_END, label: 'Iteration end', inner: true },
];
const LOOP_OUTPUTS: PortInfo[] = [
    { id: 'out-0', single: true },
    { id: ITERATION_START, label: 'Iteration start', inner: true },
];

export const isInnerPort = (type: string | undefined, side: PortSide, port: string) =>
    type === LOOP && port === (side === 'source' ? ITERATION_START : ITERATION_END);
export type PortSide = 'source' | 'target';

const chosen = (config: Record<string, unknown>, limits: { min: number; max: number; key: string }) => {
    const n = Math.round(Number(config[limits.key] ?? limits.min));
    return Math.min(limits.max, Math.max(limits.min, Number.isFinite(n) ? n : limits.min));
};

const label = (labels: string[] | undefined, i: number) => (labels?.[i] ? { label: labels[i] } : {});

export function inputPorts(type: string, config: Record<string, unknown> = {}): PortInfo[] {
    if (type === START) {
        return [];
    }
    if (type === END) {
        return [{ id: 'in-0' }];
    }
    if (type === LOOP) {
        return LOOP_INPUTS;
    }
    const logic = COMPONENTS[type];
    if (!logic) {
        return [];
    }
    const total = logic.variableInputs ? chosen(config, logic.variableInputs) : logic.inputs;
    return Array.from({ length: total }, (_, i) => ({
        id: `in-${i}`,
        ...label(logic.inputLabels, i),
        ...(logic.singleEdgeInputs ? { single: true } : {}),
    }));
}

export function outputPorts(type: string, config: Record<string, unknown> = {}): PortInfo[] {
    if (type === START) {
        return [{ id: 'out-0' }];
    }
    if (type === END) {
        return [];
    }
    if (type === LOOP) {
        return LOOP_OUTPUTS;
    }
    const logic = COMPONENTS[type];
    if (!logic) {
        return [];
    }
    const optional = typeof logic.optionalOutputs === 'function' ? logic.optionalOutputs(config) : (logic.optionalOutputs ?? []);
    const fromConfig = logic.outputsFromConfig?.(config);
    const labels = fromConfig?.map(o => o.label) ?? logic.outputLabels;
    const total = fromConfig?.length ?? (logic.variableOutputs ? chosen(config, logic.variableOutputs) : logic.outputs);
    return Array.from({ length: total }, (_, i) => {
        const id = `out-${i}`;
        return { id, ...label(labels, i), ...(optional.includes(id) ? { optional: true } : {}) };
    });
}

export const ERROR_PORT = 'error';

export function errorPort(type: string, config: Record<string, unknown> = {}): PortInfo | undefined {
    if (type === START || type === END || !COMPONENTS[type]) {
        return undefined;
    }
    return onErrorOf(type, config) === 'divert' ? { id: ERROR_PORT } : undefined;
}

export function fixedOnError(type: string, config: Record<string, unknown> = {}): ErrorPolicy | undefined {
    return COMPONENTS[type]?.fixedOnError?.(config);
}

export function onErrorOf(type: string, config: Record<string, unknown> = {}): ErrorPolicy {
    const fixed = fixedOnError(type, config);
    if (fixed) {
        return fixed;
    }
    const v = config.onError;
    return v === 'continue' || v === 'divert' ? v : 'throw';
}

export function errorEdgeIssues(
    edges: PortEdge[],
    nodeOf: (nodeId: string) => { type: string; config: Record<string, unknown> } | undefined,
): { nodeId: string; message: string }[] {
    const sources = [...new Set(edges.filter(e => e.sourcePort === ERROR_PORT).map(e => e.source))];
    return sources
        .filter(id => {
            const node = nodeOf(id);
            return !node || !errorPort(node.type, node.config);
        })
        .map(nodeId => {
            const node = nodeOf(nodeId);
            const fixed = node ? fixedOnError(node.type, node.config) : undefined;
            return {
                nodeId,
                message: fixed
                    ? `has an edge out of its error port, but its On error can only be ${fixed === 'throw' ? 'Throw' : fixed} with this configuration.`
                    : 'has an edge out of its error port, but its On error is not Divert.',
            };
        });
}

export function takesSeveral(type: string | undefined, side: PortSide, port: string | null | undefined): boolean {
    if (!type) {
        return true;
    }
    return !(side === 'source' ? outputPorts(type) : inputPorts(type)).some(p => p.id === port && p.single);
}

export type PortEdge = { source: string; sourcePort: string; target: string; targetPort: string };

export type PortNode = { type: string; config: Record<string, unknown> };

/**
 * Whether a node has the port on that side, with its config as it is now (a Lookup without its not found output, a
 * Router with one case less, On error not on Divert: no error port). A type the core does not know keeps its edges.
 */
export function hasPort(node: PortNode, side: PortSide, port: string): boolean {
    if (node.type !== START && node.type !== END && !COMPONENTS[node.type]) {
        return true;
    }
    if (side === 'target') {
        return inputPorts(node.type, node.config).some(p => p.id === port);
    }
    return outputPorts(node.type, node.config).some(p => p.id === port) || errorPort(node.type, node.config)?.id === port;
}

export function withoutDanglingEdges<E extends PortEdge>(edges: E[], nodeOf: (id: string) => PortNode | undefined): E[] {
    return edges.filter(e => {
        const source = nodeOf(e.source);
        const target = nodeOf(e.target);
        return !!source && !!target && hasPort(source, 'source', e.sourcePort) && hasPort(target, 'target', e.targetPort);
    });
}

export function connectionProblem(edge: PortEdge, edges: PortEdge[], typeOf: (nodeId: string) => string | undefined): string | undefined {
    const loopInside =
        isInnerPort(typeOf(edge.source), 'source', edge.sourcePort) && isInnerPort(typeOf(edge.target), 'target', edge.targetPort);
    if (edge.source === edge.target && !loopInside) {
        return 'A component does not connect to itself.';
    }
    if (typeOf(edge.source) === START && typeOf(edge.target) === END) {
        return 'The Start does not go straight to the End.';
    }
    if (
        edges.some(
            e =>
                e.source === edge.source &&
                e.sourcePort === edge.sourcePort &&
                e.target === edge.target &&
                e.targetPort === edge.targetPort,
        )
    ) {
        return 'These two ports are already connected.';
    }
    if (
        !takesSeveral(typeOf(edge.source), 'source', edge.sourcePort) &&
        edges.some(e => e.source === edge.source && e.sourcePort === edge.sourcePort)
    ) {
        return 'This output already goes to an input.';
    }
    if (
        !takesSeveral(typeOf(edge.target), 'target', edge.targetPort) &&
        edges.some(e => e.target === edge.target && e.targetPort === edge.targetPort)
    ) {
        return 'This input takes one edge only.';
    }
    return undefined;
}
