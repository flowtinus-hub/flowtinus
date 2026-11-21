import { COMPONENT_TYPE } from '#components/component-types';
import { toError } from '#errors/normalize-error';
import { scriptAddress } from '../../scripts/script-path';
import { inputTypeRef } from '../../scripts/type-shape';
import type { ComponentContext } from '#types/component-context.type';
import type { ComponentLogic } from '#types/component-logic.type';
import type { Envelope } from '#types/envelope.type';
import type { ExpressionField } from '#types/expression-field.type';
import { scriptOutputs, typescriptConfig } from './typescript';
import { DYNAMIC_TARGET } from '../dynamic-target';

export type ScriptArgument = ExpressionField & { name: string; type?: string };

/** `<import path>#<function>`: null when it is not one */
export function scriptFunctionRef(value: unknown): { path: string; name: string } | null {
    const ref = inputTypeRef(value);
    return ref && scriptAddress(ref.path) ? ref : null;
}

export function scriptInvokerConfig(config: Record<string, unknown>) {
    const path = config.functionPath as ExpressionField | undefined;
    return {
        target: scriptFunctionRef(config.function),
        functionPath:
            config.function === DYNAMIC_TARGET
                ? ({ value: typeof path?.value === 'string' ? path.value : '', expression: path?.expression !== false } as ExpressionField)
                : null,
        arguments: Array.isArray(config.arguments) ? (config.arguments as ScriptArgument[]) : [],
    };
}

export const invokerCode = (importPath: string, name: string) =>
    `import { ${name} as __flowtinusCalled } from '${importPath}';\n\nasync function process($input: unknown[]) {\n  return await __flowtinusCalled(...$input);\n}\n`;

export function scriptCodeOf(type: string, config: Record<string, unknown>): string | undefined {
    if (type === COMPONENT_TYPE.typescript) {
        return typescriptConfig(config).code;
    }
    if (type === scriptInvoker.type) {
        const { target } = scriptInvokerConfig(config);
        return target ? invokerCode(target.path, target.name) : undefined;
    }
    return undefined;
}

function fixedValue(text: string, type: string): unknown {
    const t = type.replace(/\s/g, '');
    if (!t || (/\bstring\b/.test(t) && !/[[{]/.test(t))) {
        return text;
    }
    if (t === 'number') {
        return Number(text);
    }
    if (t === 'boolean') {
        return text === 'true';
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function argumentValue(arg: ScriptArgument, doc: Envelope, ctx: ComponentContext): unknown {
    if (arg.expression) {
        return arg.value.trim() ? ctx.fieldValue(arg, doc) : undefined;
    }
    return arg.value === '' ? undefined : fixedValue(arg.value, arg.type ?? '');
}

export const scriptInvoker: ComponentLogic = {
    type: COMPONENT_TYPE.scriptInvoker,
    label: 'Script Invoker',
    category: 'code',
    description:
        'Calls, for each envelope, a function a script of its workspace exports (`@w/<workspace>/<project>/scripts/<path>#<name>`), its arguments in the order of its parameters, each a value or an expression on the envelope. What it returns goes to the output key (default `result`), or with Override the whole DATA.',
    example: {
        function: '@w/acme/billing/scripts/pricing/tax#total',
        arguments: [
            { name: 'amount', value: '$price', expression: true },
            { name: 'country', value: 'US', expression: false },
        ],
    },
    inputs: 1,
    outputs: 1,
    usesOverride: true,
    defaultOutputKey: 'result',
    settings: [
        { key: 'function', label: 'Function', kind: 'script-function', required: true },
        {
            key: 'functionPath',
            label: 'Function path',
            kind: 'value',
            required: true,
            default: { value: '', expression: true },
            placeholder: "'@w/acme/billing/scripts/pricing/' + $country + '#total'",
            when: { key: 'function', values: [DYNAMIC_TARGET] },
        },
        {
            key: 'arguments',
            label: 'Arguments',
            kind: 'list',
            itemLabel: 'argument',
            argumentsOf: 'function',
            item: [
                { key: 'name', label: 'Name', kind: 'text', required: true },
                { key: 'value', label: 'Value', kind: 'value', spread: true, default: { value: '', expression: false } },
            ],
        },
    ],

    validate(config) {
        const { target, functionPath } = scriptInvokerConfig(config);
        if (functionPath) {
            return functionPath.value.trim() ? [] : ['has no function path.'];
        }
        return target ? [] : ['has no function selected.'];
    },

    async *execute(inputs, config, ctx) {
        const { target: chosen, functionPath, arguments: args } = scriptInvokerConfig(config);
        if (!chosen && !functionPath) {
            throw new Error('No function selected.');
        }
        const prepared = new Map<string, ReturnType<typeof ctx.prepareScript>>();
        const callOf = (target: { path: string; name: string }) => {
            const code = invokerCode(target.path, target.name);
            if (!prepared.has(code)) {
                prepared.set(code, ctx.prepareScript(code));
            }
            return prepared.get(code)!;
        };
        const targetOf = (doc: Envelope) => {
            if (!functionPath) {
                return chosen!;
            }
            const path = ctx.fieldValue(functionPath, doc);
            const target = typeof path === 'string' ? scriptFunctionRef(path.trim()) : null;
            if (!target) {
                throw new Error(
                    `The function path ${JSON.stringify(path) ?? 'undefined'} is not a script and a function: @w/<workspace>/<project>/scripts/<path>#<function> (e.g. @w/acme/billing/scripts/pricing/total#withVat).`,
                );
            }
            return target;
        };
        let calls = 0;
        let sent = 0;
        const called = new Set<string>();
        for await (const doc of inputs['in-0'] ?? []) {
            calls += 1;
            try {
                const target = targetOf(doc);
                called.add(`${target.name} (${target.path})`);
                const call = await callOf(target);
                const returned = await call(args.map(a => argumentValue(a, doc, ctx)));
                for (const out of scriptOutputs(doc, returned, ctx.node, target.name)) {
                    sent += 1;
                    yield { port: 'out-0', doc: out };
                }
            } catch (e) {
                yield { error: toError(e), doc };
            }
        }
        ctx.log('debug', `${calls} call(s) of ${[...called].join(', ') || 'no function'}, ${sent} envelope(s) out.`);
    },
};
