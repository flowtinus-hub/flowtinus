import { expect, test } from 'bun:test';

process.env.SCRIPT_SYNC_TIMEOUT_MS = '300';
const { prepareScript } = await import('#shared/runner/prepare-script');

const logs: string[] = [];
const levels: string[] = [];
const globals = {
    run: { id: 'r1', mode: 'validation' as const, workspace: 'w', project: 'P', flow: 'F', startedAt: '2026-11-04T00:00:00Z' },
    parameters: { region: 'eu' },
    secrets: { TOKEN: 's3cret' },
    variables: { BASE: 'https://api.test' },
    log: (message: string, level = 'info') => {
        logs.push(message);
        levels.push(level);
    },
    // what the script waits for outside, as the engine would take it
    wait: <T>(promise: Promise<T>) => {
        waits.push('wait');
        return promise;
    },
};
const waits: string[] = [];

const SCRIPTS = {
    '@w/acme/shared/scripts/upload/types': `export interface IUploadInitResponse { file: { uploadId: string } }
export function uploadIdOf(response: IUploadInitResponse): string { return response.file.uploadId; }`,
    '@w/acme/billing/scripts/upload/headers': `import { uploadIdOf, type IUploadInitResponse } from '@w/acme/shared/scripts/upload/types';
export const header = (r: IUploadInitResponse) => 'id=' + uploadIdOf(r);`,
};
const NONE = { scripts: {}, hashes: {}, workspace: 'acme' };
const WITH_SCRIPTS = { ...NONE, scripts: SCRIPTS };

test('process runs with the run globals and log (the console at its levels); types do not stop it', async () => {
    logs.length = 0;
    levels.length = 0;
    const process = await prepareScript(
        `async function process($input: Data): Promise<unknown> {
  const wrong: number = 'types are not checked here';
  log('hi', $input.n, $PARAMETERS.region, $VARIABLES.BASE, $FLOW_CURRENT_RUN.mode);
  console.log({ok: true});
  console.warn('careful');
  console.error('broke');
  console.debug('detail');
  return { double: $input.n * 2, hasSecret: typeof $SECRETS.TOKEN === 'string' };
}`,
        globals,
        NONE,
    );
    expect(await process({ n: 21 })).toEqual({ double: 42, hasSecret: true });
    expect(logs).toEqual(['hi 21 eu https://api.test validation', '{"ok":true}', 'careful', 'broke', 'detail']);
    expect(levels).toEqual(['info', 'info', 'warning', 'error', 'debug']);
});

test('it imports scripts of any project of the workspace, which import each other', async () => {
    const process = await prepareScript(
        `import { header } from '@w/acme/billing/scripts/upload/headers';
import type { IUploadInitResponse } from '@w/acme/shared/scripts/upload/types';
async function process($input: IUploadInitResponse) { return header($input); }`,
        globals,
        WITH_SCRIPTS,
    );
    expect(await process({ file: { uploadId: 'u7' } })).toBe('id=u7');
});

test('what does not compile says why: an unknown script, a script of another workspace, a package, a syntax error (with its line)', async () => {
    const compiled = (code: string) => prepareScript(`${code}\nasync function process() { return x; }`, globals, WITH_SCRIPTS);
    await expect(compiled(`import { x } from '@w/acme/billing/scripts/nope';`)).rejects.toThrow(
        'The script "@w/acme/billing/scripts/nope" does not exist.',
    );
    await expect(compiled(`import { x } from '@w/acme/billing/upload/headers';`)).rejects.toThrow(
        'The script "@w/acme/billing/upload/headers" does not exist.',
    );
    await expect(compiled(`import { x } from '@w/other/billing/scripts/upload/headers';`)).rejects.toThrow(
        '"@w/other/billing/scripts/upload/headers" cannot be imported: only scripts of this workspace (@w/acme/<project>/scripts/<path>).',
    );
    await expect(compiled(`import x from 'node:fs';`)).rejects.toThrow(
        '"node:fs" cannot be imported: only scripts of this workspace (@w/acme/<project>/scripts/<path>).',
    );
    await expect(prepareScript(`async function process() {\n  return (;\n}`, globals, NONE)).rejects.toThrow(/does not compile: .*line 2/);
    await expect(prepareScript(`const x = 1;`, globals, NONE)).rejects.toThrow('The code has no process function.');
});

test('isolated: no process, require, Bun or disk; an endless loop is stopped', async () => {
    const peek = await prepareScript(
        `async function process() { return [typeof Bun, typeof globalThis.process, typeof fetch]; }`,
        globals,
        NONE,
    );
    expect(await peek(null)).toEqual(['undefined', 'undefined', 'function']);
    // a require is an import to the bundle: refused like any other that is not a project script
    await expect(prepareScript(`async function process() { return require('node:fs'); }`, globals, NONE)).rejects.toThrow(
        '"node:fs" cannot be imported',
    );
    const loop = await prepareScript(`async function process() { while (true) {} }`, globals, NONE);
    await expect(loop(null)).rejects.toThrow(/timed out|timeout/i);
});

test("what the script waits for outside goes through the engine's wait: its timers (a sleep) and its calls", async () => {
    waits.length = 0;
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
    try {
        const process = await prepareScript(
            `async function process() {
  await new Promise(resolve => setTimeout(resolve, 20));
  const response = await fetch('http://localhost:${server.port}/');
  return (await response.json()).ok;
}`,
            globals,
            NONE,
        );
        expect(await process(null)).toBe(true);
        expect(waits).toEqual(['wait', 'wait']);
        // a timer cleared before it fires ends its wait too
        const cleared = await prepareScript(
            `async function process() { clearTimeout(setTimeout(() => {}, 10_000)); return 'done'; }`,
            globals,
            NONE,
        );
        expect(await cleared(null)).toBe('done');
    } finally {
        server.stop(true);
    }
});

test("the script sees exactly the globals the core lists (what the code editor types); its run's own are not on globalThis", async () => {
    const { SCRIPT_RUNTIME_GLOBALS } = await import('@flowtinus/core');
    const ofTheRun = [
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
    ];
    const process = await prepareScript(
        `async function process() {
  return {
    onGlobalThis: Object.keys(globalThis).filter(k => !k.startsWith('__')),
    undefinedOnes: [${SCRIPT_RUNTIME_GLOBALS.map(name => `typeof ${name} === 'undefined' ? '${name}' : ''`).join(', ')}].filter(Boolean),
  };
}`,
        globals,
        NONE,
    );
    const { onGlobalThis, undefinedOnes } = (await process({})) as { onGlobalThis: string[]; undefinedOnes: string[] };
    expect(undefinedOnes).toEqual([]);
    expect(onGlobalThis.sort()).toEqual(SCRIPT_RUNTIME_GLOBALS.filter(name => !ofTheRun.includes(name)).sort());
});

test("each component run starts with fresh top-level state; a write to globalThis is shared by the worker's component runs", async () => {
    const code = `let calls = 0;
async function process($input) {
  calls += 1;
  if ($input !== null) globalThis.shared = $input;
  return { calls, shared: globalThis.shared };
}`;
    const first = await prepareScript(code, globals, NONE);
    expect(await first(null)).toEqual({ calls: 1, shared: undefined });
    expect(await first('from the first')).toEqual({ calls: 2, shared: 'from the first' });
    const second = await prepareScript(code, globals, NONE);
    expect(await second(null)).toEqual({ calls: 1, shared: 'from the first' });
    await (
        await prepareScript(`async function process() { delete globalThis.shared; }`, globals, NONE)
    )(null);
});

test('an error says where it happened in the code as written: its line, or the script and line it is in', async () => {
    const component = await prepareScript(
        `import { uploadIdOf } from '@w/acme/shared/scripts/upload/types';
interface Order { id: number }

// a comment and a type: the bundle has neither, the line is still the code's
async function process($input: Order) {
  if ($input.id === 1) throw new Error('one is not allowed');
  if ($input.id === 2) return uploadIdOf({} as never);
  const total: number = 0;
  return missing.value + total;
}`,
        globals,
        WITH_SCRIPTS,
    );
    await expect(component({ id: 1 })).rejects.toThrow('one is not allowed (line 6)');
    // in a script it imports: that script and its line
    await expect(component({ id: 2 })).rejects.toThrow('(@w/acme/shared/scripts/upload/types line 2)');
    await expect(component({ id: 3 })).rejects.toThrow(/missing is not defined \(line 9\)$/);
    // the code around process (run once, when prepared): its line too
    await expect(
        prepareScript(`const broken = null;\nconst x = broken.y;\nasync function process() { return x; }`, globals, NONE),
    ).rejects.toThrow(/\(line 2\)$/);
});

test('an error that already says where it broke keeps that place: a rethrow adds no line of its own', async () => {
    // a called flow failed: its message, rethrown by this component, already has the line of the script that broke
    const component = await prepareScript(`async function process($input) {\n  throw new Error($input.message);\n}`, globals, NONE);
    const inner = 'The flow "Child" failed: "Prepare": Unsupported value (@w/acme/dw/scripts/Shared/Sla line 24)';
    await expect(component({ message: inner })).rejects.toThrow(new RegExp(`Sla line 24\\)$`));
    await expect(component({ message: 'The flow "Child" failed: "Check": boom (line 3)' })).rejects.toThrow(/boom \(line 3\)$/);
    // a message without one still gets this line
    await expect(component({ message: 'plain' })).rejects.toThrow(/^plain \(line 2\)$/);
});

test("an error thrown with a cause keeps it out of the script's context: rethrow(firstError), or throw with { cause }", async () => {
    const { errorWithOrigin, toError } = await import('@flowtinus/core');
    const component = await prepareScript(
        `async function process($input) {
  rethrow($input.none);
  if ($input.own) throw new Error('page failed', { cause: $input.firstError });
  rethrow($input.firstError);
}`,
        globals,
        NONE,
    );
    const firstError = { error: 'Error', message: 'value too long', component: 'Insert' };
    const rethrown = toError(await component({ firstError }).catch((e: unknown) => e));
    expect(errorWithOrigin('Report', rethrown)).toBe('"Report" ← "Insert": value too long (line 4)');
    const own = toError(await component({ firstError, own: true }).catch((e: unknown) => e));
    expect(errorWithOrigin('Report', own)).toBe('"Report" ← "Insert": page failed (line 3)');
});
