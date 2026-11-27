import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readRepository } from '../../src/disk';

const folders: string[] = [];

afterEach(() => {
    for (const folder of folders.splice(0)) {
        rmSync(folder, { recursive: true, force: true });
    }
});

function folderWith(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'flowtinus-disk-')));
    folders.push(root);
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    }
    return root;
}

function git(cwd: string, ...args: string[]): void {
    const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (done.status !== 0) {
        throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
    }
}

function repoWith(tracked: Record<string, string>): string {
    const root = folderWith(tracked);
    git(root, 'init', '--quiet');
    git(root, 'add', '.');
    return root;
}

describe('readRepository', () => {
    test('in a git repository, it reads the tracked files and the untracked ones git does not ignore', () => {
        const root = repoWith({
            '.gitignore': 'secret.txt\n',
            'sales/workspace.yaml': 'name: Sales\n',
            'sales/flows/load.yaml': 'tracked\n',
        });
        writeFileSync(join(root, 'sales/flows/new.yaml'), 'untracked\n');
        writeFileSync(join(root, 'secret.txt'), 'ignored\n');

        const repository = readRepository(root);

        expect(repository.files).toEqual({
            '.gitignore': 'secret.txt\n',
            'sales/flows/load.yaml': 'tracked\n',
            'sales/flows/new.yaml': 'untracked\n',
            'sales/workspace.yaml': 'name: Sales\n',
        });
        expect(repository.workspaces).toEqual(['sales']);
    });

    test('a folder inside a git repository reads the whole repository from its top level', () => {
        const root = repoWith({ 'sales/workspace.yaml': 'name: Sales\n', 'hr/workspace.yaml': 'name: HR\n' });

        const repository = readRepository(join(root, 'sales'));

        expect(repository.root).toBe(root);
        expect(repository.workspaces).toEqual(['hr', 'sales']);
    });

    test('a tracked file deleted from the working tree is not read', () => {
        const root = repoWith({ 'sales/workspace.yaml': 'name: Sales\n', 'sales/flows/gone.yaml': 'gone\n' });
        unlinkSync(join(root, 'sales/flows/gone.yaml'));

        expect(Object.keys(readRepository(root).files)).toEqual(['sales/workspace.yaml']);
    });

    test('outside a git repository, it reads every file of the folder', () => {
        const root = folderWith({ 'sales/workspace.yaml': 'name: Sales\n', 'sales/flows/load.yaml': 'load\n' });

        const repository = readRepository(root);

        expect(repository.root).toBe(root);
        expect(repository.files).toEqual({ 'sales/flows/load.yaml': 'load\n', 'sales/workspace.yaml': 'name: Sales\n' });
        expect(repository.workspaces).toEqual(['sales']);
    });
});
