import type { TreeIssue } from '@flowtinus/core';
import { indexPaths, onDisk } from '@flowtinus/core/disk';

export function caseOnlyRenames(root: string, paths: string[]): TreeIssue[] {
    const index = indexPaths(root);
    const tracked = new Set(index);
    const byLowerCase = new Map(index.map(path => [path.toLowerCase(), path]));
    const actual = onDisk(root);
    return paths.flatMap(path => {
        const old = byLowerCase.get(path.toLowerCase());
        // two files whose names differ only in case, both on a case-sensitive disk, are a duplicate, not a rename
        if (tracked.has(path) || !old || actual(old) === old) {
            return [];
        }
        return [{ path, message: `renamed only in case on disk; git still has \`${old}\`: use \`git mv\`` }];
    });
}
