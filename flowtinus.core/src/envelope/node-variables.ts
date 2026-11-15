import type { AvailableVariable } from '#types/available-variable.type';
import type { FlowParameter } from '#types/flow-parameter.type';
import type { RunRecord } from '#types/run-record.type';
import { dataVariables, memberPath, mergeSamples } from './available-variables';

export type KnownVariables = Record<string, Record<string, AvailableVariable[]>>;

export function knownVariablesAfter(previous: KnownVariables, record: RunRecord): KnownVariables {
    const next: KnownVariables = { ...previous };
    for (const component of record.components) {
        for (const [port, samples] of Object.entries(component.outputSample)) {
            if (samples.length) {
                next[component.nodeId] = { ...next[component.nodeId], [port]: dataVariables(mergeSamples(samples)) };
            }
        }
    }
    return next;
}

const RUN_FIELDS: AvailableVariable[] = [
    { path: '$FLOW_CURRENT_RUN', type: 'object' },
    { path: '$FLOW_CURRENT_RUN.id', type: 'string' },
    { path: '$FLOW_CURRENT_RUN.mode', type: 'string', example: '"validation"' },
    { path: '$FLOW_CURRENT_RUN.workspace', type: 'string' },
    { path: '$FLOW_CURRENT_RUN.project', type: 'string' },
    { path: '$FLOW_CURRENT_RUN.flow', type: 'string' },
    { path: '$FLOW_CURRENT_RUN.startedAt', type: 'string' },
];

export function systemVariables(
    parameters: FlowParameter[],
    variables: { name: string; value?: string }[],
    secrets: string[],
): AvailableVariable[] {
    const group = (root: string, members: AvailableVariable[]): AvailableVariable[] =>
        members.length ? [{ path: root, type: 'object' }, ...members] : [];
    return [
        ...group(
            '$PARAMETERS',
            parameters
                .filter(p => p.name)
                .map(p => ({
                    path: memberPath('$PARAMETERS', p.name),
                    type: p.type === 'text' ? 'string' : p.type,
                    ...(p.default ? { example: p.type === 'text' ? JSON.stringify(p.default) : p.default } : {}),
                })),
        ),
        ...group(
            '$VARIABLES',
            variables.map(v => ({
                path: memberPath('$VARIABLES', v.name),
                type: 'string',
                ...(v.value !== undefined ? { example: JSON.stringify(v.value).slice(0, 40) } : {}),
            })),
        ),
        ...group(
            '$SECRETS',
            secrets.map(name => ({ path: memberPath('$SECRETS', name), type: 'secret' })),
        ),
        ...RUN_FIELDS,
    ];
}

export function inputVariables(
    known: KnownVariables,
    edges: { source: string; sourcePort: string; target: string; targetPort: string }[],
    nodeId: string,
    port?: string,
): { variables: AvailableVariable[]; seen: boolean } {
    const feeding = edges.filter(e => e.target === nodeId && (port === undefined || e.targetPort === port));
    const byPath = new Map<string, AvailableVariable>();
    let seen = false;
    for (const edge of feeding) {
        const variables = known[edge.source]?.[edge.sourcePort];
        if (!variables) {
            continue;
        }
        seen = true;
        for (const v of variables) {
            if (!byPath.has(v.path)) {
                byPath.set(v.path, v);
            }
        }
    }
    const whole: AvailableVariable[] = feeding.length && !byPath.has('$DATA') ? [{ path: '$DATA', type: 'object' }] : [];
    return { variables: [...whole, ...byPath.values()], seen };
}
