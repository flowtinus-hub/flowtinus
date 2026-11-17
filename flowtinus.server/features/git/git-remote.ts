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

async function runGit(
    cwd: string,
    args: string[],
    options: { access?: GitAccess | null; input?: string; env?: Record<string, string> } = {},
): Promise<string> {
    const child = Bun.spawn(['git', ...args], {
        cwd,
        env: gitEnv(options.access ?? null, options.env),
        stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: TIMEOUT_MS,
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) {
        throw new GitError(args, child.signalCode ? `git ${args[0]} took longer than ${TIMEOUT_MS / 1000} s.` : err);
    }

    return out;
}

const exists = (path: string) =>
    stat(path).then(
        () => true,
        () => false,
    );

/** A bare clone of a repository: what the server reads from it and writes to it. */
export class GitRemote {
    private constructor(
        readonly dir: string,
        private readonly access: GitAccess,
    ) {}

    /** the bare clone at `dir` (made when missing), with `origin` pointing at the repository */
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

    /** the repository's branches and their commits, as it has them now */
    async branches(): Promise<Map<string, string>> {
        const out = await this.run(['ls-remote', '--heads', 'origin']);
        const branches = new Map<string, string>();
        for (const line of out.split('\n').filter(Boolean)) {
            const [sha, ref] = line.split('\t');
            branches.set(ref!.replace(/^refs\/heads\//, ''), sha!);
        }

        return branches;
    }

    /**
     * brings the branch's commit into the clone: its sha, or null when the repository has no such branch (`branches`:
     * what branches() just answered, to spare asking again)
     */
    async fetch(branch: string, branches?: Map<string, string>): Promise<string | null> {
        const sha = (branches ?? (await this.branches())).get(branch);
        if (!sha) {
            return null;
        }

        await this.run(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
        return sha;
    }

    /** a file's content at a commit, or null when the commit has no such file */
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

    /**
     * a commit in the clone (not pushed): the parent's tree (none: empty) with the files written (content) or removed
     * (null), by the author
     */
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
            for (const [path, content] of Object.entries(options.changes)) {
                if (content === null) {
                    await this.run(['update-index', '--force-remove', '--', path], { env: index });
                } else {
                    const blob = (await this.run(['hash-object', '-w', '--stdin'], { input: content })).trim();
                    await this.run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env: index });
                }
            }

            const tree = (await this.run(['write-tree'], { env: index })).trim();
            const author = options.author ?? FLOWTINUS;
            const who = {
                GIT_AUTHOR_NAME: author.name,
                GIT_AUTHOR_EMAIL: author.email,
                GIT_COMMITTER_NAME: author.name,
                GIT_COMMITTER_EMAIL: author.email,
            };
            const parent = options.parent ? ['-p', options.parent] : [];
            return (await this.run(['commit-tree', tree, ...parent, '-F', '-'], { input: options.message, env: who })).trim();
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    }

    /**
     * moves the repository's branch to the commit, only from where it was expected (`from`: its commit, or null when it
     * must not exist yet); a provider's refusal or a branch that moved meanwhile throws GitError
     */
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

    async deleteBranch(branch: string): Promise<void> {
        await this.run(['push', '--quiet', '--porcelain', 'origin', '--delete', `refs/heads/${branch}`]);
    }
}

const queues = new Map<string, Promise<unknown>>();

/** runs `work` on the workspace's clone once the work queued before it on that clone is done */
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

/** runs `work` on a clone of its own, removed after it: for a repository that is not (or not yet) the workspace's */
export async function withThrowawayClone<T>(clonesDir: string, access: GitAccess, work: (remote: GitRemote) => Promise<T>): Promise<T> {
    await mkdir(clonesDir, { recursive: true });
    const dir = await mkdtemp(join(clonesDir, 'throwaway-'));
    try {
        return await work(await GitRemote.open(dir, access));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
