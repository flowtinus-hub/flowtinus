import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from '../../src/disk';

const folders: string[] = [];

afterEach(() => {
    for (const folder of folders.splice(0)) {
        rmSync(folder, { recursive: true, force: true });
    }
});

function repoWith(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'flowtinus-fingerprint-')));
    folders.push(root);
    for (const [path, text] of Object.entries(files)) {
        writeFileSync(join(root, path), text);
    }
    const done = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    if (done.status !== 0) {
        throw new Error(done.stderr);
    }
    return root;
}

describe('fingerprint', () => {
    test('the same while nothing changes on disk', () => {
        const root = repoWith({ 'a.yaml': 'a', '.gitignore': 'ignored.txt\n' });
        expect(fingerprint(root)).toBe(fingerprint(root));
    });

    test("changes with a file's size, its mtime, a new file and a removed one", () => {
        const root = repoWith({ 'a.yaml': 'a', 'b.yaml': 'b' });
        const seen = new Set([fingerprint(root)]);

        writeFileSync(join(root, 'a.yaml'), 'aa');
        seen.add(fingerprint(root));
        utimesSync(join(root, 'a.yaml'), new Date(2020, 0, 1), new Date(2020, 0, 1));
        seen.add(fingerprint(root));
        writeFileSync(join(root, 'c.yaml'), 'c');
        seen.add(fingerprint(root));
        unlinkSync(join(root, 'b.yaml'));
        seen.add(fingerprint(root));

        expect(seen.size).toBe(5);
    });

    test('a file git ignores is not part of it', () => {
        const root = repoWith({ 'a.yaml': 'a', '.gitignore': 'ignored.txt\n' });
        const before = fingerprint(root);
        writeFileSync(join(root, 'ignored.txt'), 'noise');
        expect(fingerprint(root)).toBe(before);
    });
});
