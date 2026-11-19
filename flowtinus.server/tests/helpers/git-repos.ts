import { rmSync } from 'node:fs';
import { join } from 'node:path';

export function git(cwd: string, ...args: string[]): string {
    const done = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (done.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')}: ${done.stderr.toString()}`);
    }

    return done.stdout.toString().trim();
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function gitWith(cwd: string, args: string[], input: string, env: Record<string, string> = {}): string {
    const done = Bun.spawnSync(['git', ...args], {
        cwd,
        stdin: Buffer.from(input),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...(process.env as Record<string, string>), ...env },
    });
    if (done.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')}: ${done.stderr.toString()}`);
    }

    return done.stdout.toString().trim();
}

export function commitFiles(repo: string, branch: string, files: Record<string, string>, message = 'files'): string {
    const index = { GIT_INDEX_FILE: join(repo, `index-${crypto.randomUUID()}`) };
    try {
        const entries = Object.entries(files).map(([path, content]) => {
            const blob = gitWith(repo, ['hash-object', '-w', '--stdin'], content);
            return `100644 ${blob}\t${path}\n`;
        });
        gitWith(repo, ['read-tree', '--empty'], '', index);
        gitWith(repo, ['update-index', '--index-info'], entries.join(''), index);
        const tree = gitWith(repo, ['write-tree'], '', index);
        const parent = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo, stdout: 'pipe' });
        const parentArgs = parent.exitCode === 0 ? ['-p', parent.stdout.toString().trim()] : [];
        const commit = gitWith(
            repo,
            ['-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', 'commit-tree', tree, ...parentArgs, '-F', '-'],
            message,
        );
        git(repo, 'update-ref', `refs/heads/${branch}`, commit);
        return commit;
    } finally {
        rmSync(index.GIT_INDEX_FILE, { force: true });
    }
}

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

export async function commitAll(call: Call, message: string): Promise<{ status: number; body: any }> {
    const changes = (await call('GET', '/git/changes')).body.changes as { path: string; from?: string }[];
    return call('POST', '/git/commit', { paths: changes.flatMap(c => [c.path, ...(c.from ? [c.from] : [])]), message });
}

export function createBranch(repo: string, branch: string): void {
    const commit = git(repo, '-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', 'commit-tree', EMPTY_TREE, '-m', 'start');
    git(repo, 'update-ref', `refs/heads/${branch}`, commit);
}
