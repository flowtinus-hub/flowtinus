import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { repoEntry } from '../repo/repo-layout';

export type Repository = { root: string; files: Record<string, string>; workspaces: string[] };

export function gitOutput(root: string, args: string[]): { ok: true; out: string } | { ok: false; err: string } {
    const done = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: Infinity });
    if (done.error) {
        throw new Error(`git: ${done.error.message}`);
    }
    return done.status === 0 ? { ok: true, out: done.stdout } : { ok: false, err: done.stderr.trim() };
}

export const indexPaths = (root: string): string[] => {
    const listed = gitOutput(root, ['ls-files', '-z']);
    return listed.ok ? listed.out.split('\0').filter(Boolean) : [];
};

// a case-insensitive disk opens a path whatever its case: only the folder's listing has the name as it is on disk
export function onDisk(root: string): (path: string) => string {
    const listings = new Map<string, string[]>();
    const listing = (folder: string) => {
        if (!listings.has(folder)) {
            try {
                listings.set(folder, readdirSync(join(root, folder)));
            } catch {
                listings.set(folder, []);
            }
        }
        return listings.get(folder)!;
    };
    return path => {
        let actual = '';
        for (const part of path.split('/')) {
            const names = listing(actual);
            const name = names.includes(part) ? part : (names.find(n => n.toLowerCase() === part.toLowerCase()) ?? part);
            actual = actual ? `${actual}/${name}` : name;
        }
        return actual;
    };
}

// a folder inside a git repository stands for the whole repository: its top level
function gitTree(folder: string): { root: string; paths: string[]; renamed: string[] } | undefined {
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
    // with core.ignorecase, git lists a file renamed only in case under the name it had
    const actual = onDisk(root);
    const names = listed.out.split('\0').filter(Boolean);
    const renamed = names.flatMap(name => (actual(name) === name ? [] : [`${name}\0${actual(name)}`]));
    return { root, paths: [...new Set(names.map(actual))], renamed };
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

const treeOf = (folder: string) => gitTree(folder) ?? { root: folder, paths: folderPaths(folder), renamed: [] };

/** the paths readRepository would read, with their sizes and mtimes: it changes with the tree, without reading a file */
export function fingerprint(folder: string): string {
    const { root, paths, renamed } = treeOf(folder);
    const hash = createHash('sha256');
    for (const rename of renamed.sort()) {
        hash.update(`${rename}\n`);
    }
    for (const path of paths.sort()) {
        try {
            const stat = statSync(join(root, path));
            hash.update(`${path}\0${stat.size}\0${stat.mtimeMs}\n`);
        } catch {
            hash.update(`${path}\0-\n`);
        }
    }
    return hash.digest('hex');
}

export function readRepository(folder: string): Repository {
    const { root, paths } = treeOf(folder);
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
