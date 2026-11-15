import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';

/**
 * A listener added to a signal that is already aborted never fires: a child (a called flow, a Loop's iteration) that
 * starts as the run stops would run on after it. Forward the run's abort with `AbortSignal.any([run, own])`, which
 * covers both. These files listen directly and check `.aborted` first; a new one is checked the same way, then added.
 */
const CHECKED = ['engine/flow-execution.ts', 'engine/http-retry.ts'];

test("the core forwards a run's abort with AbortSignal.any; a direct listener only where `.aborted` is checked first", async () => {
    const src = join(import.meta.dir, '../../src');
    const listening: string[] = [];
    for await (const path of new Glob('**/*.ts').scan(src)) {
        if ((await Bun.file(join(src, path)).text()).includes("addEventListener('abort'")) {
            listening.push(path.replaceAll('\\', '/'));
        }
    }
    expect(listening.sort()).toEqual(CHECKED);
});
