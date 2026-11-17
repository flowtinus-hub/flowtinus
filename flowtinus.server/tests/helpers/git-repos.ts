export function git(cwd: string, ...args: string[]): string {
    const done = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (done.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')}: ${done.stderr.toString()}`);
    }

    return done.stdout.toString().trim();
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** the branch, on a commit of nothing by Someone */
export function createBranch(repo: string, branch: string): void {
    const commit = git(repo, '-c', 'user.name=Someone', '-c', 'user.email=someone@example.com', 'commit-tree', EMPTY_TREE, '-m', 'start');
    git(repo, 'update-ref', `refs/heads/${branch}`, commit);
}
