import { START } from '#engine/constants';
import { nameIssue } from '#validation/key-name';
import type { FlowParameter } from '#types/flow-parameter.type';
import type { Issue } from '#types/issue.type';
import type { ParameterType } from '#types/parameter.type';
import type { SettingField } from '#types/setting-field.type';

/* The Start is not one of COMPONENTS: the engine runs it itself. */

const PARAMETER_TYPES: ParameterType[] = ['text', 'number', 'boolean'];

export const START_SETTINGS: SettingField[] = [
    { key: 'acceptsInput', label: 'Accepts input', kind: 'boolean' },
    // a project script's type as the input's type: the default input is then a form of that type; a run whose input
    // does not fit it does not start, and a Flow Invoker's call with one fails
    { key: 'inputType', label: 'Input type', kind: 'script-type', when: { key: 'acceptsInput', values: [true] } },
    {
        key: 'testInput',
        label: 'Default input (JSON)',
        kind: 'code',
        language: 'json',
        placeholder: '{"id": 1}',
        typedBy: 'inputType',
        when: { key: 'acceptsInput', values: [true] },
    },
    {
        key: 'parameters',
        label: 'Parameters',
        kind: 'list',
        itemLabel: 'parameter',
        item: [
            { key: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'since' },
            {
                key: 'type',
                label: 'Type',
                kind: 'select',
                default: 'text',
                options: [
                    { value: 'text', label: 'Text' },
                    { value: 'number', label: 'Number' },
                    { value: 'boolean', label: 'Yes/no' },
                ],
            },
            { key: 'default', label: 'Default', kind: 'text' },
            { key: 'required', label: 'Required', kind: 'boolean' },
        ],
    },
];

export function startConfig(config: Record<string, unknown>) {
    const parameters = Array.isArray(config.parameters) ? (config.parameters as Partial<FlowParameter>[]) : [];
    return {
        acceptsInput: config.acceptsInput === true,
        testInput: typeof config.testInput === 'string' ? config.testInput : '',
        parameters: parameters.map((p): FlowParameter => ({
            name: typeof p?.name === 'string' ? p.name.trim() : '',
            type: PARAMETER_TYPES.includes(p?.type as ParameterType) ? (p?.type as ParameterType) : 'text',
            default: typeof p?.default === 'string' ? p.default : p?.default === undefined || p?.default === null ? '' : String(p.default),
            ...(p?.required === true ? { required: true } : {}),
        })),
    };
}

export function startParameters(nodes: { type: string; config: Record<string, unknown> }[]): FlowParameter[] {
    const start = nodes.find(n => n.type === START);
    return start ? startConfig(start.config).parameters : [];
}

function defaultIssue(p: FlowParameter): string | null {
    const value = p.default.trim();
    if (value === '') {
        return null;
    }
    if (p.type === 'number' && !Number.isFinite(Number(value))) {
        return `"${p.default}" is not a number`;
    }
    if (p.type === 'boolean' && value !== 'true' && value !== 'false') {
        return `"${p.default}" is not true or false`;
    }
    return null;
}

export function validateStart(config: Record<string, unknown>): Issue[] {
    const { acceptsInput, testInput, parameters } = startConfig(config);
    const issues: Issue[] = [];
    const seen = new Set<string>();
    parameters.forEach((p, i) => {
        const issue = nameIssue(p.name);
        if (issue) {
            issues.push(`parameter ${i + 1} ${issue}.`);
        } else if (seen.has(p.name)) {
            issues.push(`has the parameter "${p.name}" more than once.`);
        }
        seen.add(p.name);
        const wrong = defaultIssue(p);
        if (wrong) {
            issues.push(`parameter "${p.name || i + 1}": ${wrong}.`);
        }
    });
    if (acceptsInput && testInput.trim()) {
        try {
            JSON.parse(testInput);
        } catch {
            issues.push('has a default input that is not valid JSON.');
        }
    }
    return issues;
}
