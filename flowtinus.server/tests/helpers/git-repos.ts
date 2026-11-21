import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoFlowFromYaml, repoFlowToYaml } from '@flowtinus/core';

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
    const contents = mkdtempSync(join(tmpdir(), 'flowtinus-commit-files-'));
    try {
        const paths = Object.keys(files);
        const sources = paths.map((path, i) => {
            const source = join(contents, String(i));
            writeFileSync(source, files[path]!);
            return source;
        });
        const blobs = sources.length
            ? gitWith(repo, ['hash-object', '-w', '--no-filters', '--stdin-paths'], sources.join('\n')).split('\n')
            : [];
        const entries = paths.map((path, i) => `100644 ${blobs[i]}\t${path}\n`);
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
        rmSync(contents, { recursive: true, force: true });
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

function branchFiles(repo: string, branch: string): Record<string, string> {
    const show = (path: string) => Bun.spawnSync(['git', 'show', `${branch}:${path}`], { cwd: repo, stdout: 'pipe' }).stdout.toString();
    const paths = git(repo, '-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', branch).split('\n');
    return Object.fromEntries(paths.map(path => [path, show(path)]));
}

export async function webhookInGit(call: Call, repo: string, flowId: string, branch = 'dev'): Promise<{ id: string; token: string }> {
    const files = branchFiles(repo, branch);
    const [path, read] = Object.entries(files)
        .filter(([file]) => file.endsWith('.flow.yaml'))
        .map(([file, text]) => [file, repoFlowFromYaml(text, file.split('/').pop()!.slice(0, -'.flow.yaml'.length))] as const)
        .find(([, read]) => read.ok && read.value.flow.id === flowId)!;
    if (!read.ok) {
        throw new Error(`The flow ${flowId} is not on ${branch}.`);
    }
    const id = crypto.randomUUID();
    const webhooks = [...read.value.webhooks, { id, name: 'Shop', response: 'async' as const }];
    commitFiles(repo, branch, { ...files, [path]: repoFlowToYaml(read.value.flow, { ...read.value, webhooks }) }, 'Add a webhook');
    const reconciled = await call('POST', '/git/reconcile');
    if (reconciled.body.outcome !== 'applied') {
        throw new Error(`The reconcile answered ${JSON.stringify(reconciled.body)}.`);
    }
    const { token } = (await call('PUT', `/webhooks/${id}/enabled`, { enabled: true })).body;
    return { id, token };
}
