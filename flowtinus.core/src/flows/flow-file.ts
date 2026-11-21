import { parse, stringify } from 'yaml';
import { END, START } from '#engine/constants';
import type { ExecutableEdge } from '#types/executable-edge.type';
import type { EnvelopeData } from '#types/envelope-data.type';
import type { ExecutableFlow } from '#types/executable-flow.type';
import { startParameters } from '#components/built-in/start';
import { COMPONENTS } from '../components';
import { errorEdgeIssues, withoutDanglingEdges } from '#validation/ports';
import { portConnectionIssues } from '#validation/port-connections';

/*
 * A flow as a file (YAML): what Download gives and Upload reads, and what the server can keep. One description, here,
 * for all of them. It has the components with their config and where they are on the canvas, the edges (the error
 * port's too), and the groups. No secret value is ever in it: a sensitive setting only names a secret of the workspace, and a
 * connection is a profile's id. The parameters are the Start's (in its config). `version` is the file's format: a
 * change to it gets a new number, and reading an older one converts it. A node inside a Loop's region names it in
 * `loop` (ADR 0001); a Loop's `size` keeps where its Loop end card is, for the canvas.
 */

export const FLOW_FILE_VERSION = 1;

export type Point = { x: number; y: number };

export type FlowFileNode = {
    id: string;
    type: string;
    label?: string;
    position: Point;
    config: Record<string, unknown>;
    outputKey?: string;
    override?: boolean;
    disabled?: boolean;
    pinned?: Record<string, EnvelopeData[]>;
    notes?: string;
    /** the Loop whose loop region holds it directly */
    loop?: string;
    /** a Loop's: its Loop end card on the canvas, as an offset from the Loop card */
    size?: Size;
};

export type Size = { width: number; height: number };

export type FlowFileGroup = {
    id: string;
    title: string;
    color: string;
    position: Point;
    size: { width: number; height: number };
    locked?: boolean;
};

export type FlowFile = {
    version: typeof FLOW_FILE_VERSION;
    id?: string;
    name: string;
    nodes: FlowFileNode[];
    edges: ExecutableEdge[];
    groups?: FlowFileGroup[];
};

export const slugify = (name: string) =>
    name
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

export function flowFileName(name: string): string {
    return `${slugify(name) || 'flow'}.yaml`;
}

export function flowToYaml(file: FlowFile): string {
    return stringify(leanFlow(file), { blockQuote: 'literal', lineWidth: 0, indent: 2 });
}

export function leanFlow(file: FlowFile): FlowFile {
    return {
        version: FLOW_FILE_VERSION,
        ...(file.id ? { id: file.id } : {}),
        name: file.name,
        nodes: file.nodes.map(n => ({
            id: n.id,
            type: n.type,
            ...(n.label ? { label: n.label } : {}),
            position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
            config: n.config,
            ...(n.outputKey ? { outputKey: n.outputKey } : {}),
            ...(n.override ? { override: true } : {}),
            ...(n.disabled ? { disabled: true } : {}),
            ...(n.pinned ? { pinned: n.pinned } : {}),
            ...(n.notes ? { notes: n.notes } : {}),
            ...(n.loop ? { loop: n.loop } : {}),
            ...(n.size ? { size: { width: Math.round(n.size.width), height: Math.round(n.size.height) } } : {}),
        })),
        edges: file.edges.map(e => ({ source: e.source, sourcePort: e.sourcePort, target: e.target, targetPort: e.targetPort })),
        ...(file.groups?.length ? { groups: file.groups } : {}),
    };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const MAX_PINNED_BYTES = 2 * 1024 ** 2;

const isPinned = (v: unknown): v is Record<string, EnvelopeData[]> =>
    isObject(v) && Object.values(v).every(items => Array.isArray(items) && items.every(isObject));
const isPoint = (v: unknown): v is Point => isObject(v) && Number.isFinite(v.x) && Number.isFinite(v.y);
const isSize = (v: unknown): v is Size => isObject(v) && Number.isFinite(v.width) && Number.isFinite(v.height);

export type FlowFileResult = { ok: true; value: FlowFile } | { ok: false; errors: string[] };

export function flowFromYaml(text: string): FlowFileResult {
    let data: unknown;
    try {
        data = parse(text);
    } catch (e) {
        return { ok: false, errors: [`Not valid YAML: ${e instanceof Error ? e.message : String(e)}`] };
    }
    return validateFlowFile(data);
}

export function validateFlowFile(data: unknown): FlowFileResult {
    if (!isObject(data)) {
        return { ok: false, errors: ['Not a flow file.'] };
    }

    const errors: string[] = [];
    if (data.version !== FLOW_FILE_VERSION) {
        errors.push(`Unknown file version ${JSON.stringify(data.version)} (this app reads ${FLOW_FILE_VERSION}).`);
    }
    if (typeof data.name !== 'string' || !data.name.trim()) {
        errors.push('The flow has no name.');
    }
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    if (!Array.isArray(data.nodes)) {
        errors.push('The flow has no nodes.');
    }
    const ids = new Set<string>();
    nodes.forEach((n: unknown, i) => {
        if (!isObject(n) || typeof n.id !== 'string' || !n.id || typeof n.type !== 'string' || !n.type) {
            errors.push(`Node ${i + 1} has no id or type.`);
            return;
        }
        if (ids.has(n.id)) {
            errors.push(`The node id "${n.id}" is used more than once.`);
        }
        ids.add(n.id);
        if (!isPoint(n.position)) {
            errors.push(`Node "${n.id}" has no position.`);
        }
        if (n.config !== undefined && !isObject(n.config)) {
            errors.push(`Node "${n.id}" has a config that is not an object.`);
        }
        if (n.loop !== undefined && (typeof n.loop !== 'string' || !n.loop)) {
            errors.push(`Node "${n.id}" has a loop that is not a node id.`);
        }
        if (n.size !== undefined && !isSize(n.size)) {
            errors.push(`Node "${n.id}" has a size that is not {width, height}.`);
        }
    });
    for (const type of [START, END]) {
        const count = nodes.filter((n: unknown) => isObject(n) && n.type === type).length;
        if (count !== 1) {
            errors.push(`The flow needs exactly one ${type === START ? 'Start' : 'End'} (it has ${count}).`);
        }
    }
    const edges = Array.isArray(data.edges) ? data.edges : [];
    edges.forEach((e: unknown, i) => {
        if (!isObject(e) || [e.source, e.sourcePort, e.target, e.targetPort].some(v => typeof v !== 'string')) {
            errors.push(`Edge ${i + 1} is incomplete.`);
        } else if (!ids.has(e.source as string) || !ids.has(e.target as string)) {
            errors.push(`Edge ${i + 1} connects a node that is not in the flow.`);
        }
    });
    const groups = Array.isArray(data.groups) ? data.groups : [];
    groups.forEach((g: unknown, i) => {
        if (!isObject(g) || typeof g.id !== 'string' || !isPoint(g.position) || !isObject(g.size)) {
            errors.push(`Group ${i + 1} is incomplete.`);
        }
    });
    if (errors.length) {
        return { ok: false, errors };
    }

    const typeOf = (id: string) => (nodes as Record<string, unknown>[]).find(n => n.id === id)?.type as string | undefined;
    const plainEdges = (edges as ExecutableEdge[]).map(e => ({
        source: e.source,
        sourcePort: e.sourcePort,
        target: e.target,
        targetPort: e.targetPort,
    }));
    const nodeOf = (id: string) => {
        const n = (nodes as Record<string, unknown>[]).find(node => node.id === id);
        return n ? { type: n.type as string, config: (n.config as Record<string, unknown> | undefined) ?? {} } : undefined;
    };
    const ports = [...portConnectionIssues(plainEdges, typeOf), ...errorEdgeIssues(plainEdges, nodeOf)];
    if (ports.length) {
        return { ok: false, errors: ports.map(i => `Node "${i.nodeId}" ${i.message}`) };
    }
    // an edge on a port its component no longer has (its config changed): dropDanglingEdges takes it out on load
    const kept = new Set(withoutDanglingEdges(plainEdges, nodeOf));
    const dangling = plainEdges.flatMap((e, i) =>
        kept.has(e)
            ? []
            : [`Edge ${i + 1} (${e.source} ${e.sourcePort} → ${e.target} ${e.targetPort}) is on a port its component does not have.`],
    );
    if (dangling.length) {
        return { ok: false, errors: dangling };
    }
    const pinnedBytes = (nodes as Record<string, unknown>[]).reduce(
        (n, node) => n + (isPinned(node.pinned) ? JSON.stringify(node.pinned).length : 0),
        0,
    );
    if (pinnedBytes > MAX_PINNED_BYTES) {
        return {
            ok: false,
            errors: [
                `The pinned outputs take ${(pinnedBytes / 1024 ** 2).toFixed(1)} MB (at most ${MAX_PINNED_BYTES / 1024 ** 2} MB): unpin a component.`,
            ],
        };
    }

    const value: FlowFile = {
        version: FLOW_FILE_VERSION,
        ...(typeof data.id === 'string' ? { id: data.id } : {}),
        name: (data.name as string).trim(),
        nodes: nodes.map((n: Record<string, unknown>) => ({
            id: n.id as string,
            type: n.type as string,
            ...(typeof n.label === 'string' && n.label ? { label: n.label } : {}),
            position: n.position as Point,
            config: (n.config as Record<string, unknown> | undefined) ?? {},
            ...(typeof n.outputKey === 'string' && n.outputKey ? { outputKey: n.outputKey } : {}),
            ...(n.override === true ? { override: true } : {}),
            ...(n.disabled === true ? { disabled: true } : {}),
            // pinned output: envelopes per port (a bare `true` of earlier versions had none: not pinned)
            ...(isPinned(n.pinned) ? { pinned: n.pinned } : {}),
            ...(typeof n.notes === 'string' && n.notes ? { notes: n.notes } : {}),
            ...(typeof n.loop === 'string' ? { loop: n.loop } : {}),
            ...(isSize(n.size) ? { size: { width: n.size.width, height: n.size.height } } : {}),
        })),
        edges: edges.map((e: Record<string, string>) => ({
            source: e.source,
            sourcePort: e.sourcePort,
            target: e.target,
            targetPort: e.targetPort,
        })),
        ...(groups.length
            ? {
                  groups: groups.map((g: Record<string, unknown>) => ({
                      id: g.id as string,
                      title: typeof g.title === 'string' ? g.title : '',
                      color: typeof g.color === 'string' ? g.color : '',
                      position: g.position as Point,
                      size: g.size as FlowFileGroup['size'],
                      ...(g.locked === true ? { locked: true } : {}),
                  })),
              }
            : {}),
    };
    return { ok: true, value };
}

export function newFlowFile(name: string, id?: string): FlowFile {
    return {
        version: FLOW_FILE_VERSION,
        ...(id ? { id } : {}),
        name,
        nodes: [
            { id: START, type: START, position: { x: 0, y: 0 }, config: {} },
            { id: END, type: END, position: { x: 640, y: 0 }, config: {} },
        ],
        edges: [],
    };
}

export function writingComponents(file: FlowFile): FlowFileNode[] {
    return file.nodes.filter(n => {
        const effects = COMPONENTS[n.type]?.sideEffects;
        return !n.disabled && (typeof effects === 'function' ? effects(n.config) : effects === true);
    });
}

export function toExecutableFlow(file: FlowFile, project: string, workspace?: string): ExecutableFlow {
    return {
        ...(file.id ? { id: file.id } : {}),
        ...(workspace !== undefined ? { workspace } : {}),
        project,
        flow: file.name,
        parameters: startParameters(file.nodes),
        nodes: file.nodes.map(n => ({
            id: n.id,
            type: n.type,
            label: n.label || n.type,
            config: n.config,
            ...(n.outputKey ? { outputKey: n.outputKey } : {}),
            ...(n.override && COMPONENTS[n.type]?.usesOverride ? { override: true } : {}),
            ...(n.disabled ? { disabled: true } : {}),
            ...(n.pinned ? { pinned: n.pinned } : {}),
            ...(n.loop ? { loop: n.loop } : {}),
        })),
        edges: file.edges,
    };
}

/**
 * A stored flow (raw, as saved) without the edges on ports its components no longer have, before it is read: a draft
 * saved before such an edge was taken out still opens, without it. Anything that is not a flow comes back as it is.
 */
export function dropDanglingEdges(data: unknown): unknown {
    if (!isObject(data) || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        return data;
    }
    const nodes = new Map((data.nodes as unknown[]).filter(isObject).map(n => [n.id, n]));
    const nodeOf = (id: string) => {
        const n = nodes.get(id);
        return n && typeof n.type === 'string' ? { type: n.type, config: isObject(n.config) ? n.config : {} } : undefined;
    };
    const edges = (data.edges as unknown[]).filter(
        (e): e is PortEdgeLike =>
            isObject(e) &&
            typeof e.source === 'string' &&
            typeof e.target === 'string' &&
            typeof e.sourcePort === 'string' &&
            typeof e.targetPort === 'string',
    );
    const others = (data.edges as unknown[]).filter(e => !edges.includes(e as PortEdgeLike));
    return { ...data, edges: [...withoutDanglingEdges(edges, nodeOf), ...others] };
}

type PortEdgeLike = { source: string; sourcePort: string; target: string; targetPort: string };

/** the value with every object's keys in order (Postgres' jsonb gives them back in its own order) */
const canonical = (value: unknown): unknown =>
    Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
          ? Object.fromEntries(
                Object.keys(value)
                    .sort()
                    .map(key => [key, canonical((value as Record<string, unknown>)[key])]),
            )
          : value;

const withLf = (value: unknown): unknown =>
    typeof value === 'string'
        ? value.replace(/\r\n?/g, '\n')
        : Array.isArray(value)
          ? value.map(withLf)
          : isObject(value)
            ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, withLf(v)]))
            : value;

/**
 * What a deploy compares: only what the engine takes (toExecutableFlow), as text. Not the flow's name (the row's), nor
 * what is only on the canvas or for people (where the components are, the groups, the notes), nor the pinned outputs
 * (a real run ignores them), nor whether it is deployed (the repository's `deployed`); the order of the components, of
 * the edges and of the keys does not count either, nor line endings (a clone on Windows may have CRLF). A component's
 * label does: the run's record and logs show it.
 */
export function deployContent(file: FlowFile): string {
    const { nodes, edges } = toExecutableFlow(file, '');
    const edgeKey = (e: ExecutableEdge) => [e.source, e.sourcePort, e.target, e.targetPort].join('|');
    return JSON.stringify(
        withLf(
            canonical({
                nodes: nodes.map(({ pinned: _pinned, ...node }) => node).sort((a, b) => a.id.localeCompare(b.id)),
                edges: [...edges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
            }),
        ),
    );
}

export type ComparedNode = { id: string; type: string; label: string };

export type FlowChanges = {
    added: ComparedNode[];
    removed: ComparedNode[];
    changed: (ComparedNode & { fields: string[] })[];
    edgesAdded: ExecutableEdge[];
    edgesRemoved: ExecutableEdge[];
};

const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function flowChanges(from: FlowFile, to: FlowFile): FlowChanges {
    const before = new Map(toExecutableFlow(from, '').nodes.map(n => [n.id, n]));
    const after = new Map(toExecutableFlow(to, '').nodes.map(n => [n.id, n]));
    const named = (n: { id: string; type: string; label: string }): ComparedNode => ({ id: n.id, type: n.type, label: n.label });
    const changed: FlowChanges['changed'] = [];
    for (const [id, node] of after) {
        const old = before.get(id);
        if (!old) {
            continue;
        }

        const fields: string[] = (['label', 'type', 'outputKey', 'override', 'disabled', 'loop'] as const).filter(
            key => !same(old[key], node[key]),
        );
        const keys = [...new Set([...Object.keys(old.config), ...Object.keys(node.config)])].sort();
        fields.push(...keys.filter(key => !same(old.config[key], node.config[key])).map(key => `config.${key}`));
        if (fields.length > 0) {
            changed.push({ ...named(node), fields });
        }
    }

    const edgeKey = (e: ExecutableEdge) => [e.source, e.sourcePort, e.target, e.targetPort].join('|');
    const edgesBefore = new Set(from.edges.map(edgeKey));
    const edgesAfter = new Set(to.edges.map(edgeKey));
    return {
        added: [...after.values()].filter(n => !before.has(n.id)).map(named),
        removed: [...before.values()].filter(n => !after.has(n.id)).map(named),
        changed,
        edgesAdded: to.edges.filter(e => !edgesBefore.has(edgeKey(e))),
        edgesRemoved: from.edges.filter(e => !edgesAfter.has(edgeKey(e))),
    };
}
