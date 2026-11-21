import vm from 'node:vm';
import { rethrow, SCRIPT_IMPORT_PREFIX, toError, type PrepareScript } from '@flowtinus/core';
import { bundleFrame, originalPosition, type SourceMap } from './source-position';

/*
 * The TypeScript component, in the worker: its code and the project scripts it imports become one bundle (Bun.build),
 * compiled once per worker, in one node:vm context, into a factory that takes the component run's globals as
 * parameters. node:vm separates the scope but is not a security boundary: the code is the project's, and each run has
 * a worker process of its own.
 */

/** the synchronous part of a call: an endless loop becomes the envelope's error, it does not hang the worker */
const SYNC_TIMEOUT_MS = Number(process.env.SCRIPT_SYNC_TIMEOUT_MS ?? 5_000);
const CALL_TIMEOUT_MS = Number(process.env.SCRIPT_TIMEOUT_MS ?? 30_000);

const EXPORTED = '__flowtinusProcess';
const HAND_OVER = '__flowtinusHandOver';

/** a response with its body already read: reading it is part of the call (Waiting), not of the script's work */
const bodyRead = async (response: Response) =>
    new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers });

const text = (parts: unknown[]) => parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');

export type Bundle = { js: string; map: SourceMap | null };

export async function bundleScript(code: string, scripts: Record<string, string>): Promise<Bundle> {
    // the component's code is a module that exports its process (an export keeps it an ES module, whatever it uses),
    // and a small entry hands it to the caller
    if (!/\bfunction\s+process\s*\(/.test(code)) {
        throw new Error('The code has no process function.');
    }

    const component = `${code}\n;export { process as ${EXPORTED} };\n`;
    const entry = `import { ${EXPORTED} } from 'flowtinus:code';\n${HAND_OVER}(${EXPORTED});\n`;
    let result: Awaited<ReturnType<typeof Bun.build>>;
    try {
        result = await Bun.build({
            entrypoints: ['flowtinus:component'],
            target: 'browser',
            format: 'iife',
            minify: false,
            sourcemap: 'external',
            throw: false,
            plugins: [
                {
                    name: 'project-scripts',
                    setup(build) {
                        build.onResolve({ filter: /.*/ }, args => {
                            if (args.path === 'flowtinus:component') {
                                return { path: 'entry.ts', namespace: 'flowtinus' };
                            }

                            if (args.path === 'flowtinus:code') {
                                return { path: 'component.ts', namespace: 'flowtinus' };
                            }

                            if (args.path.startsWith(SCRIPT_IMPORT_PREFIX)) {
                                const path = args.path.slice(SCRIPT_IMPORT_PREFIX.length);
                                if (!(path in scripts)) {
                                    throw new Error(`The script "${args.path}" does not exist in this project.`);
                                }

                                return { path: `scripts/${path}.ts`, namespace: 'flowtinus' };
                            }

                            throw new Error(
                                `"${args.path}" cannot be imported: only the project's scripts (${SCRIPT_IMPORT_PREFIX}<path>).`,
                            );
                        });
                        build.onLoad({ filter: /.*/, namespace: 'flowtinus' }, args => ({
                            contents:
                                args.path === 'entry.ts'
                                    ? entry
                                    : args.path === 'component.ts'
                                      ? component
                                      : scripts[args.path.slice('scripts/'.length, -'.ts'.length)]!,
                            loader: 'ts',
                        }));
                    },
                },
            ],
        });
    } catch (e) {
        throw new SyntaxError(`The code does not compile: ${toError(e).message}`);
    }

    if (!result.success || !result.outputs[0]) {
        const messages = result.logs
            .filter(log => log.level === 'error')
            .map(log => {
                const where = log.position
                    ? ` (${log.position.file.replace(/^flowtinus:/, '').replace(/^scripts\//, SCRIPT_IMPORT_PREFIX)} line ${log.position.line})`
                    : '';
                return `${log.message}${where}`;
            });
        throw new SyntaxError(`The code does not compile: ${messages.join('; ') || 'unknown error'}`);
    }

    const map = result.outputs.find(output => output.kind === 'sourcemap');
    let parsed: SourceMap | null = null;
    try {
        parsed = map ? (JSON.parse(await map.text()) as SourceMap) : null;
    } catch {}

    return { js: await result.outputs[0].text(), map: parsed };
}

const BUNDLE_FILE = 'component.ts';

/**
 * a message that already says where it happened: one that came from another component's error (a flow called and
 * failed, its message rethrown by this one), which already has its own "(line N)"
 */
const ALREADY_LOCATED = new RegExp(`\\((?:${SCRIPT_IMPORT_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^()]+ )?line \\d+\\)`);

/**
 * The error with where it happened in the code as written, when its stack and the map say so: "(line 7)" in the
 * component's code, "(@myproject/scripts/path line 3)" in a script it imports. Only once: a message that already has
 * one (an error from a called flow, rethrown) keeps that one, where it really broke; each component that passed it on
 * adding its own line made "(line 24) (line 3) (line 2) (line 1)".
 */
export function located(error: unknown, map: SourceMap | null): unknown {
    const stack = typeof (error as { stack?: unknown })?.stack === 'string' ? (error as { stack: string }).stack : '';
    const frame = map ? bundleFrame(stack, BUNDLE_FILE) : null;
    const position = frame ? originalPosition(map!, frame.line, frame.column) : null;
    const source = position?.source.replace(/^flowtinus:/, '') ?? '';
    const where =
        source === 'component.ts'
            ? `line ${position!.line}`
            : source.startsWith('scripts/')
              ? `${SCRIPT_IMPORT_PREFIX}${source.slice('scripts/'.length, -'.ts'.length)} line ${position!.line}`
              : '';
    const message = (error as { message?: unknown })?.message;
    if (where && typeof message === 'string' && !ALREADY_LOCATED.test(message)) {
        (error as { message: string }).message = `${message} (${where})`;
    }
    return error;
}

const RUN_GLOBALS = [
    '$PARAMETERS',
    '$SECRETS',
    '$VARIABLES',
    '$FLOW_CURRENT_RUN',
    'log',
    'console',
    'fetch',
    'setTimeout',
    'clearTimeout',
    'rethrow',
    HAND_OVER,
];

type Factory = (...globals: unknown[]) => void;
type Compiled = { factory: Factory; map: SourceMap | null };

let context: vm.Context | undefined;
let invoke: vm.Script | undefined;
let pending: (() => unknown) | undefined;

function sharedContext(): vm.Context {
    context ??= vm.createContext({
        Headers,
        Request,
        Response,
        URL,
        URLSearchParams,
        AbortController,
        FormData,
        Blob,
        TextEncoder,
        TextDecoder,
        atob,
        btoa,
        structuredClone,
        crypto: { randomUUID: () => crypto.randomUUID() },
        __flowtinusInvoke: () => pending!(),
    });
    return context;
}

// through a script run in the context: the sync timeout only stops what a vm script started
function inContext<T>(call: () => T): T {
    const previous = pending;
    pending = call;
    try {
        invoke ??= new vm.Script('__flowtinusInvoke()');
        return invoke.runInContext(sharedContext(), { timeout: SYNC_TIMEOUT_MS }) as T;
    } finally {
        pending = previous;
    }
}

function compile({ js, map }: Bundle): Compiled {
    const script = new vm.Script(`(function (${RUN_GLOBALS.join(', ')}) {${js}\n})`, { filename: BUNDLE_FILE });
    return { factory: script.runInContext(sharedContext()) as Factory, map };
}

/** compiled in this worker, by the component's code and its scripts' hashes */
const compiled = new Map<string, Compiled>();
const KEPT_SCRIPTS = 50;

async function cachedScript(code: string, scripts: Record<string, string>, hashes: Record<string, string>): Promise<Compiled> {
    if (Object.keys(scripts).length > 0 && Object.keys(hashes).length === 0) {
        return compile(await bundleScript(code, scripts));
    }

    const key = new Bun.CryptoHasher('sha256')
        .update(code)
        .update(JSON.stringify(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))))
        .digest('hex');
    const known = compiled.get(key);
    if (known !== undefined) {
        compiled.delete(key);
        compiled.set(key, known);
        return known;
    }

    const script = compile(await bundleScript(code, scripts));
    compiled.set(key, script);
    if (compiled.size > KEPT_SCRIPTS) {
        compiled.delete(compiled.keys().next().value!);
    }

    return script;
}

export const prepareScript = async (
    code: string,
    globals: Parameters<PrepareScript>[1],
    scripts: Record<string, string> = {},
    hashes: Record<string, string> = {},
) => {
    const { factory, map } = await cachedScript(code, scripts, hashes);
    const log = (...parts: unknown[]) => globals.log(text(parts));
    const at =
        (level: 'debug' | 'warning' | 'error') =>
        (...parts: unknown[]) =>
            globals.log(text(parts), level);
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
    let exported: unknown;
    try {
        inContext(() =>
            factory(
                globals.parameters,
                globals.secrets,
                globals.variables,
                globals.run,
                log,
                { log, info: log, warn: at('warning'), error: at('error'), debug: at('debug') },
                // what the script waits for outside counts as Waiting, not Active: its calls (until the whole body is in)
                // and its timers (a sleep)
                (...args: Parameters<typeof fetch>) => globals.wait(fetch(...args).then(bodyRead)),
                (handler: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
                    let done: () => void = () => {};
                    void globals.wait(new Promise<void>(resolve => (done = resolve)));
                    const timer = setTimeout(() => {
                        done();
                        handler(...rest);
                    }, ms);
                    timers.set(timer, done);
                    return timer;
                },
                (timer: ReturnType<typeof setTimeout>) => {
                    timers.get(timer)?.();
                    timers.delete(timer);
                    clearTimeout(timer);
                },
                rethrow,
                (process: unknown) => (exported = process),
            ),
        );
    } catch (e) {
        throw toError(located(e, map));
    }

    if (typeof exported !== 'function') {
        throw new Error('The code has no process function.');
    }

    const run = exported as (input: unknown) => unknown;
    return async (input: unknown) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const overrun = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`process took longer than ${CALL_TIMEOUT_MS / 1000} s.`)), CALL_TIMEOUT_MS);
        });
        try {
            return await Promise.race([Promise.resolve(inContext(() => run(input))), overrun]);
        } catch (e) {
            throw located(e, map);
        } finally {
            clearTimeout(timer);
        }
    };
};
