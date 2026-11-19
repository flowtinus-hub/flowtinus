import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type GitAccess = { repository: string; token: string };

export type GitAuthor = { name: string; email: string };

export class GitError extends Error {
    override name = 'GitError';
    constructor(
        readonly args: string[],
        readonly stderr: string,
    ) {
        super(stderr.trim() || `git ${args[0]} failed.`);
    }
}

const TIMEOUT_MS = 60_000;

const FLOWTINUS: GitAuthor = { name: 'Flowtinus', email: 'flowtinus@localhost' };

// the token goes in the environment of each git process: never in the clone's config, a URL or a command line others can list
function gitEnv(access: GitAccess | null, extra: Record<string, string> = {}): Record<string, string> {
    const config: [string, string][] = [
        ['credential.helper', ''],
        ['core.autocrlf', 'false'],
    ];
    if (access && /^https?:/i.test(access.repository)) {
        // GitLab takes any username but a blank one with a token; GitHub ignores it
        config.push(['http.extraHeader', `Authorization: Basic ${Buffer.from(`oauth2:${access.token}`).toString('base64')}`]);
    }

    return {
        ...(process.env as Record<string, string>),
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: 'http:https:file',
        GIT_CONFIG_COUNT: String(config.length),
        ...Object.fromEntries(
            config.flatMap(([key, value], i) => [
                [`GIT_CONFIG_KEY_${i}`, key],
                [`GIT_CONFIG_VALUE_${i}`, value],
            ]),
        ),
        ...extra,
    };
}

type RunOptions = { access?: GitAccess | null; input?: string; env?: Record<string, string> };

async function runGitBytes(cwd: string, args: string[], options: RunOptions = {}): Promise<Uint8Array> {
    const child = Bun.spawn(['git', ...args], {
        cwd,
        env: gitEnv(options.access ?? null, options.env),
        stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: TIMEOUT_MS,
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) {
        throw new GitError(args, child.signalCode ? `git ${args[0]} took longer than ${TIMEOUT_MS / 1000} s.` : err);
    }

    return out;
}

const runGit = async (cwd: string, args: string[], options: RunOptions = {}) =>
    new TextDecoder().decode(await runGitBytes(cwd, args, options));

const exists = (path: string) =>
    stat(path).then(
        () => true,
        () => false,
    );

export class GitRemote {
    private constructor(
        readonly dir: string,
        private readonly access: GitAccess,
    ) {}

    static async open(dir: string, access: GitAccess): Promise<GitRemote> {
        if (!(await exists(join(dir, 'HEAD')))) {
            await mkdir(dir, { recursive: true });
            await runGit(dir, ['init', '--bare', '--quiet']);
            await runGit(dir, ['remote', 'add', 'origin', access.repository]);
        } else {
            await runGit(dir, ['remote', 'set-url', 'origin', access.repository]);
        }

        return new GitRemote(dir, access);
    }

    run(args: string[], options: { input?: string; env?: Record<string, string> } = {}): Promise<string> {
        return runGit(this.dir, args, { ...options, access: this.access });
    }

    async branches(): Promise<Map<string, string>> {
        const out = await this.run(['ls-remote', '--heads', 'origin']);
        const branches = new Map<string, string>();
        for (const line of out.split('\n').filter(Boolean)) {
            const [sha, ref] = line.split('\t');
            branches.set(ref!.replace(/^refs\/heads\//, ''), sha!);
        }

        return branches;
    }

    async fetch(branch: string, branches?: Map<string, string>): Promise<string | null> {
        const sha = (branches ?? (await this.branches())).get(branch);
        if (!sha) {
            return null;
        }

        await this.run(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
        return sha;
    }

    /** every head of the remote fetched (a head removed there goes here too): each one's tip, by name */
    async fetchHeads(): Promise<Map<string, string>> {
        await this.run(['fetch', '--quiet', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
        const out = await this.run(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/origin/']);
        const heads = new Map<string, string>();
        for (const line of out.split('\n').filter(Boolean)) {
            const [sha, ref] = line.split(' ') as [string, string];
            const name = ref.slice('refs/remotes/origin/'.length);
            if (name !== 'HEAD') {
                heads.set(name, sha);
            }
        }
        return heads;
    }

    async isAncestor(commit: string, of: string): Promise<boolean> {
        try {
            await this.run(['merge-base', '--is-ancestor', commit, of]);
            return true;
        } catch (e) {
            if (e instanceof GitError) {
                return false;
            }
            throw e;
        }
    }

    async hasCommit(commit: string): Promise<boolean> {
        try {
            await this.run(['cat-file', '-e', `${commit}^{commit}`]);
            return true;
        } catch (e) {
            if (e instanceof GitError) {
                return false;
            }
            throw e;
        }
    }

    async readFile(commit: string, path: string): Promise<string | null> {
        try {
            return await this.run(['cat-file', 'blob', `${commit}:${path}`]);
        } catch (e) {
            if (e instanceof GitError) {
                return null;
            }

            throw e;
        }
    }

    async files(commit: string, paths: string[]): Promise<Record<string, string>> {
        const listed = (await this.run(['ls-tree', '-r', '-z', commit, '--', ...paths]))
            .split('\0')
            .filter(Boolean)
            .map(line => {
                const [meta, path] = line.split('\t') as [string, string];
                const [mode, type, sha] = meta.split(' ') as [string, string, string];
                return { mode, type, sha, path };
            })
            .filter(entry => entry.type === 'blob' && entry.mode !== '120000');
        if (listed.length === 0) {
            return {};
        }

        const out = await runGitBytes(this.dir, ['cat-file', '--batch'], { input: listed.map(e => `${e.sha}\n`).join('') });
        const decoder = new TextDecoder();
        const files: Record<string, string> = {};
        let at = 0;
        for (const { path } of listed) {
            const header = out.indexOf(10, at);
            const size = Number(decoder.decode(out.subarray(at, header)).split(' ')[2]);
            files[path] = decoder.decode(out.subarray(header + 1, header + 1 + size));
            at = header + 1 + size + 1;
        }

        return files;
    }

    async commit(options: {
        parent: string | null;
        changes: Record<string, string | null>;
        message: string;
        author?: GitAuthor;
    }): Promise<string> {
        const temp = await mkdtemp(join(this.dir, 'index-'));
        const index = { GIT_INDEX_FILE: join(temp, 'index') };
        try {
            await this.run(options.parent ? ['read-tree', options.parent] : ['read-tree', '--empty'], { env: index });
            const entries: string[] = [];
            for (const [path, content] of Object.entries(options.changes)) {
                // mode 0 takes the path out of the index: update-index --force-remove wants a work tree, which a bare clone has not
                const blob =
                    content === null ? '0'.repeat(40) : (await this.run(['hash-object', '-w', '--stdin'], { input: content })).trim();
                entries.push(`${content === null ? '0' : '100644'} ${blob}\t${path}\n`);
            }
            if (entries.length > 0) {
                await this.run(['update-index', '--index-info'], { env: index, input: entries.join('') });
            }

            const tree = (await this.run(['write-tree'], { env: index })).trim();
            if (options.parent && tree === (await this.run(['rev-parse', `${options.parent}^{tree}`])).trim()) {
                return options.parent;
            }

            const author = options.author ?? FLOWTINUS;
            const who = {
                GIT_AUTHOR_NAME: author.name,
                GIT_AUTHOR_EMAIL: author.email,
                GIT_COMMITTER_NAME: FLOWTINUS.name,
                GIT_COMMITTER_EMAIL: FLOWTINUS.email,
            };
            const parent = options.parent ? ['-p', options.parent] : [];
            return (await this.run(['commit-tree', tree, ...parent, '-F', '-'], { input: options.message, env: who })).trim();
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    }

    async push(commit: string, branch: string, from: string | null): Promise<void> {
        await this.run([
            'push',
            '--quiet',
            '--porcelain',
            `--force-with-lease=refs/heads/${branch}:${from ?? ''}`,
            'origin',
            `${commit}:refs/heads/${branch}`,
        ]);
    }

    async pushDryRun(commit: string, branch: string): Promise<void> {
        await this.run(['push', '--quiet', '--porcelain', '--dry-run', 'origin', `${commit}:refs/heads/${branch}`]);
    }

    async deleteBranch(branch: string): Promise<void> {
        await this.run(['push', '--quiet', '--porcelain', 'origin', '--delete', `refs/heads/${branch}`]);
    }
}

const queues = new Map<string, Promise<unknown>>();

export function withWorkspaceClone<T>(
    clonesDir: string,
    workspaceId: string,
    access: GitAccess,
    work: (remote: GitRemote) => Promise<T>,
): Promise<T> {
    const dir = join(clonesDir, workspaceId);
    const previous = queues.get(dir) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => work(await GitRemote.open(dir, access)));
    queues.set(dir, next);
    void next
        .finally(() => {
            if (queues.get(dir) === next) {
                queues.delete(dir);
            }
        })
        .catch(() => undefined);
    return next;
}

export async function withThrowawayClone<T>(clonesDir: string, access: GitAccess, work: (remote: GitRemote) => Promise<T>): Promise<T> {
    await mkdir(clonesDir, { recursive: true });
    const dir = await mkdtemp(join(clonesDir, 'throwaway-'));
    try {
        return await work(await GitRemote.open(dir, access));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
