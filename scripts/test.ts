/*
 * `bun run test` at the root: every package's tests but the server's tests/containers (Testcontainers and supervisor
 * processes: Docker and a minute or two on CI), the suites at the same time, each one's output printed whole when it
 * ends (failures last, so they are what the terminal shows). `bun run test:all` (--all) adds tests/containers, in
 * parallel (mostly waiting on Docker and on timers): CI runs it on pull requests to main. The rest of the server
 * (PGlite in memory: CPU) runs in up to three shards, one file at a time each: one per 4 cores, so CI's 4 cores run
 * one (with more, the tests ran out of time). Side by side, a test may take longer than Bun's 5 s default, hence
 * --timeout. Exits 1 when any suite failed.
 */

import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

type Suite = { name: string; cwd: string; args: string[] };

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHARDS = Math.min(3, Math.max(1, Math.floor(availableParallelism() / 4)));
const SUITES: Suite[] = [
    ...(process.argv.includes('--all')
        ? [{ name: 'server: containers', cwd: 'flowtinus.server', args: ['tests/containers', '--parallel=6'] }]
        : []),
    ...Array.from({ length: SHARDS }, (_, i) => ({
        name: SHARDS > 1 ? `server ${i + 1}/${SHARDS}` : 'server',
        cwd: 'flowtinus.server',
        args: ['--path-ignore-patterns=tests/containers/**', '--timeout=30000', ...(SHARDS > 1 ? [`--shard=${i + 1}/${SHARDS}`] : [])],
    })),
    { name: 'core', cwd: 'flowtinus.core', args: ['--timeout=30000'] },
    { name: 'cli', cwd: 'flowtinus.cli', args: ['--timeout=30000'] },
    { name: 'editor', cwd: 'flowtinus.editor', args: [] },
    // the perf package's own code (its scenarios run with `bun run perf`, not here)
    { name: 'perf', cwd: 'flowtinus.perf', args: [] },
];

const started = performance.now();
const results = await Promise.all(
    SUITES.map(async suite => {
        const begin = performance.now();
        const child = Bun.spawn(['bun', 'test', ...suite.args], {
            cwd: `${ROOT}${suite.cwd}`,
            env: { ...process.env, FORCE_COLOR: process.stdout.isTTY ? '1' : '0' },
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        const seconds = ((performance.now() - begin) / 1000).toFixed(1);
        console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${suite.name} (${seconds}s)`);
        return { suite, code, output: out + err };
    }),
);

// passed suites only summed up; a failed one whole, at the end
for (const { suite, code, output } of results.toSorted((a, b) => Number(a.code !== 0) - Number(b.code !== 0))) {
    console.log(`\n===== ${suite.name} =====`);
    console.log(
        code === 0
            ? output
                  .split('\n')
                  .filter(line => /^\s*\d+ (pass|fail|skip)|^Ran /.test(line))
                  .join('\n')
            : output,
    );
}

const failed = results.filter(r => r.code !== 0).map(r => r.suite.name);
console.log(
    `\n${failed.length ? `FAILED: ${failed.join(', ')}` : 'all suites passed'} in ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
process.exit(failed.length ? 1 : 0);
