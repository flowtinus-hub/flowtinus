import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { slashed } from '@flowtinus/core/disk';
import { hasComment, repoEntry, type RepoFileResult } from '@flowtinus/core';
import { NO_WORKSPACE, plural, report, repositoryArgs, type Command } from '../command';
import { isRepoFileKind, REPO_FILES } from '../repo-files';

const USAGE =
    "Usage: flowtinus fmt [dir | file...] [--check]\n  dir: the repository's root, the current folder by default\n  file: only these files";

function formatted(path: string, text: string, workspaces: string[]): RepoFileResult<string> | undefined {
    const entry = repoEntry(path);
    if (!isRepoFileKind(entry.kind) || !('workspace' in entry) || !workspaces.includes(entry.workspace)) {
        return undefined;
    }
    return REPO_FILES[entry.kind].format(text, 'name' in entry ? entry.name : '');
}

// PROTOTYPE (#86): files given, only those (an agent formats what it changed, not the whole repository)
function onlyFiles(args: string[], cwd: string): { files: string[]; rest: string[] } {
    const isFile = (a: string) => {
        const path = resolve(cwd, a);
        return !a.startsWith('-') && existsSync(path) && statSync(path).isFile();
    };
    return { files: args.filter(isFile).map(a => resolve(cwd, a)), rest: args.filter(a => !isFile(a)) };
}

export const run: Command = async (args, cwd) => {
    const given = onlyFiles(args, cwd);
    const parsed = repositoryArgs('fmt', USAGE, given.files.length ? [...given.rest, dirname(given.files[0]!)] : args, cwd, {
        check: { type: 'boolean' },
    });
    if (parsed.usage) {
        return parsed.usage;
    }
    const check = parsed.values.check === true;
    const { root, workspaces } = parsed.repository;
    const only = given.files.length ? new Set(given.files.map(f => slashed(relative(root, f)))) : undefined;
    const files = only
        ? Object.fromEntries(Object.entries(parsed.repository.files).filter(([path]) => only.has(path)))
        : parsed.repository.files;
    if (workspaces.length === 0) {
        return { code: 1, output: `${NO_WORKSPACE.path}: error: ${NO_WORKSPACE.message}\n` };
    }
    const lines: string[] = [];
    let changed = 0;
    let refused = 0;
    let read = 0;
    for (const [path, text] of Object.entries(files)) {
        const result = formatted(path, text, workspaces);
        if (result === undefined) {
            continue;
        }
        read++;
        if (!result.ok) {
            refused++;
            lines.push(...result.errors.map(message => `${path}: error: ${message}`));
            continue;
        }
        if (result.value === text) {
            continue;
        }
        changed++;
        lines.push(`${path}: ${check ? 'not formatted' : 'formatted'}`);
        if (hasComment(text)) {
            const comment = check ? 'It has a comment, which fmt drops' : 'Its comments were dropped';
            lines.push(`${path}: warning: ${comment}: a node's notes keep what a comment would.`);
        }
        if (!check) {
            writeFileSync(join(root, path), result.value);
        }
    }
    const counts = [
        ...(changed || !refused ? [`${plural(changed, 'file')} ${check ? 'not formatted' : 'formatted'}`] : []),
        ...(refused ? [`${plural(refused, 'file')} not read`] : []),
    ];
    const count = changed || refused ? `${counts.join(', ')}.` : read ? `${plural(read, 'file')} already formatted.` : 'No file to format.';
    return report(refused > 0 || (check && changed > 0) ? 1 : 0, lines, count);
};
