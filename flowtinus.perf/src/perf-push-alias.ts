/*
 * Sets the repository's own git alias `git perf-push` (see perf-push.ts). Run by the root `prepare` script, after
 * husky, on every `bun install`. A shell alias (`!`) runs from the repository root and gets the arguments after it.
 * Outside a git checkout (an export, a tarball) it does nothing.
 */

const inRepo = Bun.spawnSync(['git', 'rev-parse', '--is-inside-work-tree'], { stdout: 'pipe', stderr: 'ignore' });
if (inRepo.exitCode === 0 && inRepo.stdout.toString().trim() === 'true') {
    const set = Bun.spawnSync(['git', 'config', '--local', 'alias.perf-push', '!bun flowtinus.perf/src/perf-push.ts'], {
        stdout: 'ignore',
        stderr: 'inherit',
    });
    if (set.exitCode !== 0) {
        console.error('The git alias perf-push could not be set (git config failed).');
    }
}
