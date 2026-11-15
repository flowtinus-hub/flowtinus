import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join } from 'node:path';
import { RESULTS_DIR, resultsPath, type ResultLine } from '#perf/results';
import { SCENARIOS } from '#perf/scenarios';
import { checkDocker, PACKAGE_ROOT, PerfError } from '#perf/stack';

/*
 * `git perf-push <git push arguments>`: a git push that measures what it pushes. The alias (set by `bun install`, see
 * perf-push-alias.ts) runs this script from the repository root. In order:
 *
 *   1. git push --dry-run --porcelain: the push must update exactly one branch; its new sha is what gets measured, and
 *      a push that would be rejected fails here, in seconds.
 *   2. a temporary worktree of that sha, its own install, and every scenario at its default size with 5 runs.
 *   3. the real git push, only if every scenario passed.
 *   4. the measurement (the result lines) appended to <hostname>.jsonl on the results branch, perf-results, written
 *      from a second temporary worktree and pushed without force; retried with a fresh fetch, and kept in
 *      results/unsent.json for the next git perf-push when it still fails.
 *
 * The results branch is pushed with plain `git push`, never through the alias, so it never measures again. The
 * vocabulary (result line, measurement, machine, results branch) is GLOSSARY.md's.
 */

const RESULTS_BRANCH = 'perf-results';
const RUNS = 5;
const ATTEMPTS = 3;
const UNSENT = join(RESULTS_DIR, 'unsent.json');
const WORKFLOW_TEMPLATE = join(PACKAGE_ROOT, 'pages', 'perf-results-pages.yml');
const WORKFLOW_PATH = '.github/workflows/perf-pages.yml';

class Refusal extends Error {
    constructor(
        message: string,
        readonly code = 1,
    ) {
        super(message);
    }
}

const ROOT = dirname(PACKAGE_ROOT);

/** a git command whose output we read; throws with git's own message when it fails */
function git(args: string[], cwd = ROOT): string {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed:\n${result.stderr.toString().trim()}`);
    }

    return result.stdout.toString().trim();
}

// every git push below is measured or is the results branch: the pre-push reminder to use git perf-push stays quiet
process.env.FLOWTINUS_PERF_PUSH = '1';

let child: ReturnType<typeof Bun.spawn> | undefined;
let interrupted = false;

/** a long command on the terminal (install, benchmarks, push); its exit code */
async function run(cmd: string[], cwd = ROOT): Promise<number> {
    child = Bun.spawn(cmd, { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    try {
        return await child.exited;
    } finally {
        child = undefined;
    }
}

/*
 * Ctrl+C reaches the children too (the benchmarks save a partial result and stop): here it only keeps the process
 * alive long enough for the `finally`s to remove the worktrees.
 */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(signal, () => {
        if (interrupted) {
            // a second Ctrl+C: leave now, a stray worktree is cleaned by `git worktree prune`
            process.exit(130);
        }

        interrupted = true;
    });
}

// ── 1. what the push updates ──────────────────────────────────────────────────────────────────────────────────────

const HEADS = 'refs/heads/';

/** from: the local ref pushed, whose commit must still be the measured one at the real push */
type Target = { sha: string; from: string; branch: string; remoteUrl: string };

/**
 * The porcelain lines of a dry run: `<flag>\t<from>:<to>\t<summary>`, after `To <url>`. A new branch's summary has no
 * sha, so the sha is read from the local ref being pushed.
 */
function pushTarget(args: string[]): Target {
    if (args.some(a => a === '--dry-run' || a === '-n' || /^-[^-]*n/.test(a))) {
        throw new Refusal(
            'git perf-push does not take --dry-run: it would record a commit the remote does not have; use `git push --dry-run`.',
        );
    }

    const dry = Bun.spawnSync(['git', 'push', '--dry-run', '--porcelain', ...args], {
        cwd: ROOT,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const out = dry.stdout.toString();
    if (dry.exitCode !== 0) {
        throw new Refusal(
            `The push would fail, nothing was measured or pushed:\n${(dry.stderr.toString() + out).trim()}`,
            dry.exitCode || 1,
        );
    }

    const remoteUrl = out.match(/^To (.+)$/m)?.[1]?.trim() ?? '';
    const refs = out
        .split('\n')
        .map(line => line.match(/^(.)\t([^:]*):(\S+)\t/))
        .filter(m => m !== null)
        .map(([, flag, from, to]) => ({ flag: flag!, from: from!, to: to! }));
    // a remote with several push URLs prints one block per URL: the same branch appears once per block
    const branches = [
        ...new Map(refs.filter(r => r.to.startsWith(HEADS) && [' ', '+', '*'].includes(r.flag)).map(r => [r.to, r])).values(),
    ];
    const plainPush = 'use plain `git push` for that';
    if (branches.length > 1) {
        throw new Refusal(
            `This push updates ${branches.length} branches (${branches.map(b => b.to.slice(HEADS.length)).join(', ')}): git perf-push measures one; ${plainPush}.`,
        );
    }

    if (branches.length === 0) {
        const what = refs.some(r => r.flag === '-')
            ? 'only deletes'
            : refs.some(r => r.to.startsWith('refs/tags/') && r.flag !== '=')
              ? 'updates only tags'
              : 'has nothing to push';
        throw new Refusal(`This push ${what}: git perf-push measures a branch's new commit; ${plainPush}.`);
    }

    const [ref] = branches as [(typeof branches)[0]];
    return { sha: commitOf(ref.from), from: ref.from, branch: ref.to.slice(HEADS.length), remoteUrl };
}

const commitOf = (ref: string) => git(['rev-parse', `${ref}^{commit}`]);

/** https://github.com/<owner>/<repo>/commit/<sha>, from the https or ssh URL of a GitHub remote; undefined otherwise */
export function githubCommitUrl(remoteUrl: string, sha: string): string | undefined {
    const m = remoteUrl.match(
        /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|[^@/:]+@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    );
    return m ? `https://github.com/${m[1]}/${m[2]}/commit/${sha}` : undefined;
}

type Remote = { remote: string; named: boolean };

/** the remote's name when the URL is one of them (so its tracking ref of the results branch stays current), else the URL */
function remoteFor(url: string): Remote {
    for (const name of git(['remote']).split('\n').filter(Boolean)) {
        const urls = git(['remote', 'get-url', '--push', '--all', name]).split('\n');
        if (urls.includes(url)) {
            return { remote: name, named: true };
        }
    }

    return { remote: url, named: false };
}

// ── 2. measuring ──────────────────────────────────────────────────────────────────────────────────────────────────

function tempDir(prefix: string) {
    return mkdtempSync(join(os.tmpdir(), prefix));
}

function removeWorktree(dir: string) {
    try {
        git(['worktree', 'remove', '--force', dir]);
    } catch {
        // pruned below
    }

    // on Windows `git worktree remove` leaves the folders of node_modules' links (junctions) behind; rmSync removes a
    // link without following it
    rmSync(dir, { recursive: true, force: true });
    try {
        git(['worktree', 'prune']);
    } catch {
        // nothing left to do: `git worktree prune` cleans it up later
    }
}

const readLines = (dir: string): ResultLine[] =>
    existsSync(dir)
        ? readdirSync(dir)
              .filter(name => name.endsWith('.jsonl'))
              .flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n'))
              .filter(text => text.trim())
              .flatMap(text => {
                  try {
                      return [JSON.parse(text) as ResultLine];
                  } catch {
                      return [];
                  }
              })
        : [];

async function measure(target: Target): Promise<ResultLine[]> {
    try {
        await checkDocker(SCENARIOS.map(s => s.services));
    } catch (e) {
        throw new Refusal(`${e instanceof PerfError ? e.message : String(e)}\nNothing was measured or pushed.`, 2);
    }

    const dir = tempDir('flowtinus-perf-push-');
    console.log(`\nMeasuring ${target.sha.slice(0, 7)} (${target.branch}) in ${dir}`);
    try {
        git(['worktree', 'add', '--detach', dir, target.sha]);
        const install = await run([process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts'], dir);
        if (install !== 0 || interrupted) {
            throw new Refusal(
                interrupted
                    ? 'Interrupted: nothing was pushed.'
                    : `bun install failed in the worktree (exit ${install}): nothing was pushed.`,
                interrupted ? 130 : 1,
            );
        }

        const code = await run([process.execPath, 'flowtinus.perf/src/cli.ts', '--runs', String(RUNS)], dir);
        if (code !== 0 || interrupted) {
            throw new Refusal(
                interrupted || code === 130
                    ? 'Interrupted: nothing was pushed.'
                    : `The benchmarks did not pass (exit ${code}: ${code === 2 ? 'the environment, Docker or a port' : 'a run failed'}): nothing was pushed.`,
                interrupted ? 130 : code,
            );
        }

        const lines = readLines(join(dir, 'flowtinus.perf', 'results'));
        const wrong = lines.filter(l => l.partial || l.git.dirty || l.git.sha !== target.sha);
        if (lines.length === 0 || wrong.length) {
            throw new Refusal(
                lines.length
                    ? `${wrong.length} result line(s) are partial, dirty or of another commit: nothing was pushed.`
                    : 'The benchmarks wrote no result: nothing was pushed.',
            );
        }

        const url = githubCommitUrl(target.remoteUrl, target.sha);
        return lines.map(l => ({ ...l, git: { sha: l.git.sha, dirty: false, ...(url ? { url } : {}) } }));
    } finally {
        removeWorktree(dir);
    }
}

// ── 4. the results branch ─────────────────────────────────────────────────────────────────────────────────────────

const readUnsent = (): ResultLine[] => {
    if (!existsSync(UNSENT)) {
        return [];
    }

    try {
        const parsed = JSON.parse(readFileSync(UNSENT, 'utf8')) as unknown;
        return Array.isArray(parsed) ? (parsed as ResultLine[]) : [];
    } catch {
        const aside = UNSENT.replace(/\.json$/, `.broken-${Date.now()}.json`);
        renameSync(UNSENT, aside);
        console.error(`${UNSENT} is not readable JSON: moved to ${aside}, and not sent.`);
        return [];
    }
};

/** one attempt: start from the remote's tip of the results branch (or nothing), append, commit, push without force */
function sendOnce(dir: string, { remote, named }: Remote, lines: ResultLine[], target: Target, hostname: string): void {
    const exists = git(['ls-remote', '--heads', remote, RESULTS_BRANCH], dir) !== '';
    let parent: string | undefined;
    if (exists) {
        git(['fetch', '--quiet', remote, `refs/heads/${RESULTS_BRANCH}`], dir);
        parent = git(['rev-parse', 'FETCH_HEAD'], dir);
        git(['reset', '--quiet', '--hard', parent], dir);
        git(['clean', '-fdxq'], dir);
    } else {
        git(['read-tree', '--empty'], dir);
        git(['clean', '-fdxq'], dir);
        mkdirSync(join(dir, dirname(WORKFLOW_PATH)), { recursive: true });
        copyFileSync(WORKFLOW_TEMPLATE, join(dir, WORKFLOW_PATH));
    }

    const byFile = new Map<string, ResultLine[]>();
    for (const line of lines) {
        const file = basename(resultsPath(line.machine.hostname, dir));
        byFile.set(file, [...(byFile.get(file) ?? []), line]);
    }

    for (const [file, fileLines] of byFile) {
        const path = join(dir, file);
        const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
        const text = fileLines.map(l => `${JSON.stringify(l)}\n`).join('');
        writeFileSync(path, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${text}`);
    }

    git(['add', '--all'], dir);
    const tree = git(['write-tree'], dir);
    const message = `perf: ${target.sha.slice(0, 7)} ${target.branch} @ ${hostname}\n\n${target.sha}\n${new Date().toISOString()}`;
    const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], dir);
    git(['push', '--quiet', remote, `${commit}:refs/heads/${RESULTS_BRANCH}`], dir);
    if (named) {
        // keep the remote's tracking ref as a fetch would
        git(['update-ref', `refs/remotes/${remote}/${RESULTS_BRANCH}`, commit], dir);
    }
}

function send(measurement: ResultLine[], target: Target): void {
    const unsent = readUnsent();
    if (unsent.length) {
        console.log(`Also sending ${unsent.length} result line(s) left unsent by an earlier git perf-push (${UNSENT}).`);
    }

    const lines = [...unsent, ...measurement];
    const hostname = os.hostname();
    const remote = remoteFor(target.remoteUrl);
    const dir = tempDir('flowtinus-perf-results-');
    let sent = false;
    let lastError = '';
    try {
        git(['worktree', 'add', '--quiet', '--detach', '--no-checkout', dir, 'HEAD']);
        for (let attempt = 1; attempt <= ATTEMPTS && !sent && !interrupted; attempt++) {
            try {
                sendOnce(dir, remote, lines, target, hostname);
                sent = true;
            } catch (e) {
                lastError = e instanceof Error ? e.message : String(e);
                if (attempt < ATTEMPTS) {
                    console.error(`Pushing ${RESULTS_BRANCH} failed (attempt ${attempt} of ${ATTEMPTS}), trying again on a fresh fetch.`);
                }
            }
        }
    } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
    } finally {
        removeWorktree(dir);
        if (sent) {
            rmSync(UNSENT, { force: true });
        } else {
            mkdirSync(RESULTS_DIR, { recursive: true });
            writeFileSync(UNSENT, `${JSON.stringify(lines, null, 2)}\n`);
        }
    }

    if (sent) {
        console.log(`\nThe measurement of ${target.sha.slice(0, 7)} (${lines.length} result line(s)) is on ${RESULTS_BRANCH}.`);
    } else {
        throw new Refusal(
            `The code was pushed, but ${RESULTS_BRANCH} could not be:\n${lastError}\nThe result lines are kept in ${UNSENT}; the next git perf-push sends them.`,
        );
    }
}

// ── the command ───────────────────────────────────────────────────────────────────────────────────────────────────

async function main(args: string[]): Promise<number> {
    const target = pushTarget(args);
    const measurement = await measure(target);
    if (interrupted) {
        throw new Refusal('Interrupted: nothing was pushed.', 130);
    }

    if (commitOf(target.from) !== target.sha) {
        throw new Refusal(
            `${target.from} moved while it was measured (it was ${target.sha.slice(0, 7)}): nothing was pushed; run git perf-push again.`,
        );
    }

    console.log(`\nPushing: git push ${args.join(' ')}`.trimEnd());
    const pushed = await run(['git', 'push', ...args]);
    if (pushed !== 0) {
        throw new Refusal(`git push failed (exit ${pushed}): the measurement is discarded.`, pushed);
    }

    send(measurement, target);
    return 0;
}

if (import.meta.main) {
    try {
        process.exit(await main(Bun.argv.slice(2)));
    } catch (e) {
        if (e instanceof Refusal) {
            console.error(`\ngit perf-push: ${e.message}`);
            process.exit(e.code);
        }

        throw e;
    }
}
