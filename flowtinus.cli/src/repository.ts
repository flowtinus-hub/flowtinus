import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { repoEntry } from '@flowtinus/core';

export type Repository = { root: string; files: Record<string, string>; workspaces: string[] };

function gitOutput(root: string, args: string[]): { ok: true; out: string } | { ok: false; err: string } {
    const done = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    return done.exitCode === 0 ? { ok: true, out: done.stdout.toString() } : { ok: false, err: done.stderr.toString().trim() };
}

function gitPaths(root: string): string[] | undefined {
    const inside = gitOutput(root, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok) {
        if (/not a git repository/i.test(inside.err)) {
            return undefined;
        }
        throw new Error(`git: ${inside.err}`);
    }
    const listed = gitOutput(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (!listed.ok) {
        throw new Error(`git: ${listed.err}`);
    }
    return [...new Set(listed.out.split('\0').filter(Boolean))];
}

const folderPaths = (root: string): string[] =>
    readdirSync(root, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
        .filter(path => path !== '.git' && !path.startsWith('.git/'));

const readText = (root: string, path: string): string | undefined => {
    try {
        return readFileSync(join(root, path), 'utf8');
    } catch {
        return undefined;
    }
};

export function readRepository(root: string): Repository {
    const paths = (gitPaths(root) ?? folderPaths(root)).sort();
    const files: Record<string, string> = {};
    for (const path of paths) {
        // a tracked file deleted from the working tree, or a submodule's folder
        const text = readText(root, path);
        if (text !== undefined) {
            files[path] = text;
        }
    }
    const workspaces = Object.keys(files).flatMap(path => {
        const entry = repoEntry(path);
        return entry.kind === 'workspace' ? [entry.workspace] : [];
    });
    return { root, files, workspaces };
}
