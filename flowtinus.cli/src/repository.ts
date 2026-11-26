import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { repoEntry } from '@flowtinus/core';

export type Repository = { root: string; files: Record<string, string>; workspaces: string[] };

function gitOutput(root: string, args: string[]): { ok: true; out: string } | { ok: false; err: string } {
    const done = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    return done.exitCode === 0 ? { ok: true, out: done.stdout.toString() } : { ok: false, err: done.stderr.toString().trim() };
}

// a folder inside a git repository stands for the whole repository: its top level
function gitTree(folder: string): { root: string; paths: string[] } | undefined {
    const top = gitOutput(folder, ['rev-parse', '--show-toplevel']);
    if (!top.ok) {
        if (/not a git repository/i.test(top.err)) {
            return undefined;
        }
        throw new Error(`git: ${top.err}`);
    }
    const root = resolve(top.out.trim());
    const listed = gitOutput(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (!listed.ok) {
        throw new Error(`git: ${listed.err}`);
    }
    return { root, paths: [...new Set(listed.out.split('\0').filter(Boolean))] };
}

export const slashed = (path: string) => path.split(sep).join('/');

const folderPaths = (root: string): string[] =>
    readdirSync(root, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => slashed(relative(root, join(entry.parentPath, entry.name))))
        .filter(path => path !== '.git' && !path.startsWith('.git/'));

const readText = (root: string, path: string): string | undefined => {
    try {
        return readFileSync(join(root, path), 'utf8');
    } catch {
        return undefined;
    }
};

export function readRepository(folder: string): Repository {
    const { root, paths } = gitTree(folder) ?? { root: folder, paths: folderPaths(folder) };
    paths.sort();
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
