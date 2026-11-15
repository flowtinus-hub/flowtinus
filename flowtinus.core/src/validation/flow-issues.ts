import { COMPONENTS } from '../components';
import { componentIssues, componentSettings, settingVisible } from '#components/settings';
import { END, LOOP, START } from '#engine/constants';
import { parse } from 'yaml';
import { ARROW_CARD_WIDTH, CARD_HEIGHT, CARD_WIDTH, cardWidth, PORT_GAP, SIDE_GAP } from '../flows/card-geometry';
import { validateFlowFile, type FlowFile } from '../flows/flow-file';
import { expressionSyntaxError } from './expression-check';
import { findCycle } from './flow-cycle';
import { cycleGraph, cycleNodeId, cycleNodeName, loopRegionIssues } from './loop-region';
import { nameIssue } from './key-name';
import { inputPorts, outputPorts } from './ports';
import type { SettingField } from '#types/setting-field.type';

export type FlowIssue = { nodeId?: string; settingKey?: string; port?: string; message: string };

export type FlowCheck = {
    ok: boolean;
    issues: FlowIssue[];
    /** allowed, but probably not what was meant */
    warnings: FlowIssue[];
    flow?: FlowFile;
};

const nodeIdOf = (message: string) => /^Node "([^"]+)"/.exec(message)?.[1];

function expressions(fields: SettingField[], values: Record<string, unknown>, path: string): { key: string; expression: string }[] {
    const found: { key: string; expression: string }[] = [];
    for (const field of fields) {
        if (!settingVisible(field, values, fields)) {
            continue;
        }
        const key = path ? `${path}.${field.key}` : field.key;
        if (field.kind === 'expression') {
            const v = values[field.key];
            if (typeof v === 'string' && v.trim()) {
                found.push({ key, expression: v });
            }
        } else if (field.kind === 'value') {
            const v = (field.spread ? values : values[field.key]) as { value?: unknown; expression?: unknown } | undefined;
            if (v && v.expression === true && typeof v.value === 'string' && v.value.trim()) {
                found.push({ key: field.spread ? (path ? `${path}.value` : 'value') : key, expression: v.value });
            }
        } else if (field.kind === 'list' && field.item) {
            const items = Array.isArray(values[field.key]) ? (values[field.key] as unknown[]) : [];
            items.forEach((item, i) => {
                const level = field.flat ? { [field.item![0]!.key]: item } : (item as Record<string, unknown>);
                if (level && typeof level === 'object') {
                    found.push(...expressions(field.item!, level, `${key}.${i}`));
                }
            });
        }
    }
    return found;
}

function numberOf(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

export function numberRangeIssues(
    fields: SettingField[],
    values: Record<string, unknown>,
    path = '',
): { key: string; label: string; value: number; message: string }[] {
    const found: { key: string; label: string; value: number; message: string }[] = [];
    for (const field of fields) {
        if (!settingVisible(field, values, fields)) {
            continue;
        }
        const key = path ? `${path}.${field.key}` : field.key;
        if (field.kind === 'number' && (field.min !== undefined || field.max !== undefined)) {
            const value = numberOf(values[field.key]);
            if (value !== null && field.min !== undefined && value < field.min) {
                found.push({ key, label: field.label, value, message: `is ${value}, below its minimum ${field.min}` });
            } else if (value !== null && field.max !== undefined && value > field.max) {
                found.push({ key, label: field.label, value, message: `is ${value}, above its maximum ${field.max}` });
            }
        } else if (field.kind === 'list' && field.item) {
            const items = Array.isArray(values[field.key]) ? (values[field.key] as unknown[]) : [];
            items.forEach((item, i) => {
                const level = field.flat ? { [field.item![0]!.key]: item } : (item as Record<string, unknown>);
                if (level && typeof level === 'object') {
                    found.push(...numberRangeIssues(field.item!, level, `${key}.${i}`));
                }
            });
        }
    }
    return found;
}

export function checkFlow(data: unknown): FlowCheck {
    const read = validateFlowFile(data);
    if (!read.ok) {
        return {
            ok: false,
            issues: read.errors.map(message => {
                const nodeId = nodeIdOf(message);
                return nodeId ? { nodeId, message } : { message };
            }),
            warnings: [],
        };
    }

    const flow = read.value;
    const issues: FlowIssue[] = [];
    const warnings: FlowIssue[] = [];
    const name = (id: string) => {
        const n = flow.nodes.find(node => node.id === id);
        return n?.label || (n ? (COMPONENTS[n.type]?.label ?? n.type) : id);
    };

    for (const node of flow.nodes) {
        if (node.type !== START && node.type !== END && !COMPONENTS[node.type]) {
            issues.push({
                nodeId: node.id,
                message: `Node "${node.id}" has an unknown type "${node.type}" (list_components gives the types).`,
            });
            continue;
        }
        if (node.outputKey) {
            const issue = nameIssue(node.outputKey);
            if (issue) {
                issues.push({ nodeId: node.id, settingKey: 'outputKey', message: `"${name(node.id)}": output key ${issue}.` });
            }
        }
        if (node.disabled) {
            continue;
        }
        for (const message of componentIssues(node.type, node.config)) {
            issues.push({ nodeId: node.id, message: `"${name(node.id)}" ${message}` });
        }
        // every component: a number setting outside its bounds (the form does not let a person type it; a file can)
        for (const range of numberRangeIssues(componentSettings(node.type), node.config)) {
            issues.push({
                nodeId: node.id,
                settingKey: range.key,
                message: `"${name(node.id)}": ${range.label} (${range.key}) ${range.message}.`,
            });
        }
        for (const { key, expression } of expressions(componentSettings(node.type), node.config, '')) {
            const error = expressionSyntaxError(expression);
            if (error) {
                issues.push({
                    nodeId: node.id,
                    settingKey: key,
                    message: `"${name(node.id)}": the expression in ${key} does not compile: ${error}`,
                });
            } else {
                const long = longExpression(expression);
                if (long) {
                    warnings.push({
                        nodeId: node.id,
                        settingKey: key,
                        message: `"${name(node.id)}": the expression in ${key} ${long}: a TypeScript component (which can import project scripts) or a Script Invoker reads better (a suggestion, not an error).`,
                    });
                }
            }
        }
    }

    for (const { nodeId, message } of loopRegionIssues(flow.nodes, flow.edges)) {
        issues.push({ nodeId, message: `"${name(nodeId)}" ${message}` });
    }

    const graph = cycleGraph(flow.nodes, flow.edges);
    const cycle = findCycle(graph.ids, graph.edges);
    if (cycle) {
        issues.push({
            nodeId: cycleNodeId(cycle[0]!),
            message: `The flow has a cycle (an infinite loop): ${cycle.map(id => cycleNodeName(id, name)).join(' → ')}.`,
        });
    }

    for (const node of flow.nodes) {
        if (node.disabled || (node.type !== START && node.type !== END && !COMPONENTS[node.type])) {
            continue;
        }
        for (const port of inputPorts(node.type, node.config)) {
            if (!flow.edges.some(e => e.target === node.id && e.targetPort === port.id)) {
                warnings.push({
                    nodeId: node.id,
                    port: port.id,
                    message: `"${name(node.id)}": input ${port.label ?? port.id} has no edge, so it never gets an envelope.`,
                });
            }
        }
        for (const port of outputPorts(node.type, node.config)) {
            if (!port.optional && !flow.edges.some(e => e.source === node.id && e.sourcePort === port.id)) {
                warnings.push({
                    nodeId: node.id,
                    port: port.id,
                    message: `"${name(node.id)}": output ${port.label ?? port.id} has no edge (what goes out there is lost; use a Discard to drop on purpose).`,
                });
            }
        }
    }

    warnings.push(...overlaps(flow, name));

    return { ok: issues.length === 0, issues, warnings, flow };
}

const LONG_EXPRESSION = 300;

export function longExpression(expression: string): string | null {
    if (
        /\(\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>[\s\S]*\)\s*\(/.test(expression) ||
        /\(\s*function\b[\s\S]*\}\s*\)\s*\(/.test(expression)
    ) {
        return 'is a function called in place (an IIFE)';
    }
    if (expression.length > LONG_EXPRESSION) {
        return `has ${expression.length} characters`;
    }
    return null;
}

/*
 * The canvas (card-geometry.ts, the editor's too): a card is taller with more ports, one PORT_GAP step per port. Cards
 * side by side one width apart are fitted (the editor's snap-to-connect: the output's bump in the input's hole), which
 * is fine; a card over another hides it and its edges.
 */
function overlaps(flow: FlowFile, name: (id: string) => string): FlowIssue[] {
    const known = flow.nodes.filter(n => n.type !== LOOP && (n.type === START || n.type === END || COMPONENTS[n.type]));
    const height = (n: FlowFile['nodes'][number]) =>
        CARD_HEIGHT + (Math.max(inputPorts(n.type, n.config).length, outputPorts(n.type, n.config).length, 1) - 1) * PORT_GAP;
    const found: FlowIssue[] = [];
    known.forEach((a, i) => {
        for (const b of known.slice(i + 1)) {
            // the left one's width: the Start and the End are narrower
            const left = a.position.x <= b.position.x ? a : b;
            const dx = Math.abs(a.position.x - b.position.x);
            const top = Math.max(a.position.y, b.position.y);
            const bottom = Math.min(a.position.y + height(a), b.position.y + height(b));
            if (dx < cardWidth(left.type) - SIDE_GAP && bottom > top) {
                found.push({
                    nodeId: b.id,
                    message: `"${name(b.id)}" (${b.id}) is drawn over "${name(a.id)}" (${a.id}) at positions ${a.position.x},${a.position.y} and ${b.position.x},${b.position.y}: a person cannot see it or its edges. Cards are ${CARD_WIDTH} × ${CARD_HEIGHT} px (the Start and the End ${ARROW_CARD_WIDTH} wide); side by side one width apart they fit (and connect in the editor), farther apart (~300 px) the edges show.`,
                });
            }
        }
    });
    return found;
}

export function checkFlowYaml(text: string): FlowCheck {
    let data: unknown;
    try {
        data = parse(text);
    } catch (e) {
        return { ok: false, issues: [{ message: `Not valid YAML: ${e instanceof Error ? e.message : String(e)}` }], warnings: [] };
    }
    return checkFlow(data);
}
