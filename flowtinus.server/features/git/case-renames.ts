import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TreeIssue } from '@flowtinus/core';

function indexPaths(root: string): string[] {
    const done = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: Infinity });
    return done.status === 0 ? done.stdout.split('\0').filter(Boolean) : [];
}

// a case-insensitive disk opens a path whatever its case: only the folder's listing has the name as it is on disk
function onDisk(root: string): (path: string) => string {
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

export function caseOnlyRenames(root: string, paths: string[]): TreeIssue[] {
    const index = indexPaths(root);
    const tracked = new Set(index);
    const byLowerCase = new Map(index.map(path => [path.toLowerCase(), path]));
    const actual = onDisk(root);
    return paths.flatMap(path => {
        const name = actual(path);
        const old = byLowerCase.get(name.toLowerCase());
        // two files whose names differ only in case, both on a case-sensitive disk, are a duplicate, not a rename
        if (tracked.has(name) || !old || actual(old) === old) {
            return [];
        }
        return [{ path: name, message: `renamed only in case on disk; git still has \`${old}\`: use \`git mv\`` }];
    });
}
