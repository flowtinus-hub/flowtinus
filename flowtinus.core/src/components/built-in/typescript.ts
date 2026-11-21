import { COMPONENT_TYPE } from '#components/component-types';
import { withKey } from '#envelope/envelope-data';
import { toError } from '#errors/normalize-error';
import type { ComponentLogic } from '#types/component-logic.type';
import type { Envelope } from '#types/envelope.type';
import type { ExecutableNode } from '#types/executable-node.type';

export const DEFAULT_CODE = `async function process($input: Data) {
  return null
}
`;

export function typescriptConfig(config: Record<string, unknown>) {
    return { code: typeof config.code === 'string' ? config.code : DEFAULT_CODE };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function scriptOutputs(doc: Envelope, returned: unknown, node: ExecutableNode, who = 'process'): Envelope[] {
    if (!node.override) {
        return [withKey(doc, node.outputKey || 'result', returned ?? null)];
    }
    if (returned === null || returned === undefined) {
        return [];
    }
    const items = Array.isArray(returned) ? returned : [returned];
    if (!items.every(isObject)) {
        throw new TypeError(`With Override, ${who} must return an object, a list of objects or null.`);
    }
    return items.map(DATA => ({ FLOW_CURRENT_RUN: doc.FLOW_CURRENT_RUN, PARAMETERS: doc.PARAMETERS, DATA }));
}

export const typescript: ComponentLogic = {
    type: COMPONENT_TYPE.typescript,
    label: 'TypeScript',
    category: 'code',
    description:
        "Runs `async function process($input)` for each envelope ($input is its DATA). It can import the project's scripts: `import { f } from '@myproject/scripts/<path>'`. Its return goes to the output key (default `result`); with Override it is the whole DATA (object = 1 envelope, list = 1 per item, null = none). A throw is the envelope's error (rethrow(e): another component's, naming where it began). Globals: $PARAMETERS, $SECRETS, $VARIABLES, $FLOW_CURRENT_RUN, log(), rethrow(). Top-level code runs anew per component run (each Loop iteration, called flow); globalThis is shared by the run.",
    example: { code: 'async function process($input: Data) {\n  return { total: $input.price * $input.quantity };\n}\n' },
    inputs: 1,
    outputs: 1,
    usesOverride: true,
    defaultOutputKey: 'result',
    settings: [{ key: 'code', label: 'Code', kind: 'code', language: 'typescript', required: true, default: DEFAULT_CODE }],

    validate(config) {
        const { code } = typescriptConfig(config);
        return /\bfunction\s+process\s*\(/.test(code) ? [] : ['has no process function.'];
    },

    async *execute(inputs, config, ctx) {
        const { code } = typescriptConfig(config);
        const process = await ctx.prepareScript(code);
        let received = 0;
        let sent = 0;
        for await (const doc of inputs['in-0'] ?? []) {
            received += 1;
            try {
                const returned = await process(doc.DATA);
                for (const out of scriptOutputs(doc, returned, ctx.node)) {
                    sent += 1;
                    yield { port: 'out-0', doc: out };
                }
            } catch (e) {
                yield { error: toError(e), doc };
            }
        }
        ctx.log('debug', `${received} envelope(s) in and ${sent} out.`);
    },
};
