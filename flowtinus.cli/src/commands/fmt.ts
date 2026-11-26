import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectionFromYaml, connectionToYaml, hasComment, projectFromYaml, projectToYaml, repoEntry, repoFlowFromYaml, repoFlowToYaml, workspaceFromYaml, workspaceToYaml, type RepoFileResult } from '@flowtinus/core';
import { parseCommandArgs, usageError, type Command } from '../command';
import { readRepository } from '../repository';

const USAGE = 'Usage: flowtinus fmt [dir] [--check]';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const canonical = <T>(read: RepoFileResult<T>, write: (value: T) => string): RepoFileResult<string> =>
    read.ok ? { ok: true, value: write(read.value) } : read;

function canonicalForm(path: string, text: string, workspaces: string[]): RepoFileResult<string> | undefined {
    const entry = repoEntry(path);
    if (!('workspace' in entry) || !workspaces.includes(entry.workspace)) {
        return undefined;
    }
    switch (entry.kind) {
        case 'workspace':
            return canonical(workspaceFromYaml(text), workspaceToYaml);
        case 'connection':
            return canonical(connectionFromYaml(text), connectionToYaml);
        case 'project':
            return canonical(projectFromYaml(text), projectToYaml);
        case 'flow':
            return canonical(repoFlowFromYaml(text, entry.name), ({ flow, ...triggers }) => repoFlowToYaml(flow, triggers));
        default:
            return undefined;
    }
}

export const run: Command = async (args, cwd) => {
    const parsed = parseCommandArgs(args, { check: { type: 'boolean' } });
    if ('error' in parsed) {
        return usageError(parsed.error, USAGE);
    }
    if (parsed.positionals.length > 1) {
        return usageError('fmt takes one folder at most.', USAGE);
    }
    const check = parsed.values.check === true;
    const { root, files, workspaces } = readRepository(resolve(cwd, parsed.positionals[0] ?? '.'));
    if (workspaces.length === 0) {
        return { code: 1, output: '.: error: No workspace here: no folder with a workspace.yaml.\n' };
    }
    const lines: string[] = [];
    let changed = 0;
    let unread = 0;
    for (const [path, text] of Object.entries(files)) {
        const formatted = canonicalForm(path, text, workspaces);
        if (formatted === undefined) {
            continue;
        }
        if (!formatted.ok) {
            unread++;
            lines.push(...formatted.errors.map(message => `${path}: error: ${message}`));
            continue;
        }
        if (formatted.value === text) {
            continue;
        }
        changed++;
        lines.push(`${path}: ${check ? 'not formatted' : 'formatted'}`);
        if (hasComment(text)) {
            const comment = check ? 'It has a comment, which fmt drops' : 'Its comments were dropped';
            lines.push(`${path}: warning: ${comment}: a node's notes keep what a comment would.`);
        }
        if (!check) {
            writeFileSync(join(root, path), formatted.value);
        }
    }
    const counts = [
        ...(changed || !unread ? [`${plural(changed, 'file')} ${check ? 'not formatted' : 'formatted'}`] : []),
        ...(unread ? [`${plural(unread, 'file')} not read`] : []),
    ];
    const count = changed || unread ? `${counts.join(', ')}.` : 'No file to format.';
    const failed = unread > 0 || (check && changed > 0);
    return { code: failed ? 1 : 0, output: [...lines, count, ''].join('\n') };
};
