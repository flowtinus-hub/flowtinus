import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { CONNECTION_TYPES, connectionToYaml, newFlowFile, projectToYaml, repoEntry, repoFlowToYaml, validateWorkspaceTree, type ConnectionTypeName, type RepoEntry } from '@flowtinus/core';
import { parseCommandArgs, usageError, type Command } from '../command';
import { readRepository } from '../repository';

const USAGE = 'Usage: flowtinus new flow <path> | new project <dir> | new connection <path> --type <type>';

const PLACES = {
    flow: '<workspace>/projects/<project>/flows/[<folder>/…]<name>.flow.yaml',
    project: '<workspace>/projects/<project>/project.yaml',
    connection: '<workspace>/connections/<name>.yaml',
};

type Kind = keyof typeof PLACES;

const isKind = (kind: string | undefined): kind is Kind => kind !== undefined && kind in PLACES;

const slashed = (path: string) => path.split(sep).join('/');

function fileText(entry: RepoEntry, type: ConnectionTypeName | undefined): string {
    const id = crypto.randomUUID();
    switch (entry.kind) {
        case 'flow':
            return repoFlowToYaml(newFlowFile(entry.name, id));
        case 'project':
            return projectToYaml({ id, description: '' });
        default:
            return connectionToYaml({ id, type: type! });
    }
}

function workspaceAbove(folder: string): string | undefined {
    for (let at = folder; ; at = dirname(at)) {
        if (existsSync(join(at, 'workspace.yaml'))) {
            return at;
        }
        if (dirname(at) === at) {
            return undefined;
        }
    }
}

export const run: Command = async (args, cwd) => {
    const parsed = parseCommandArgs(args, { type: { type: 'string' } });
    if ('error' in parsed) {
        return usageError(parsed.error, USAGE);
    }
    const [kind, path, ...extra] = parsed.positionals;
    if (!isKind(kind)) {
        return usageError(
            kind === undefined ? 'Which kind: flow, project or connection?' : `Unknown kind "${kind}": flow, project or connection.`,
            USAGE,
        );
    }
    if (path === undefined || extra.length > 0) {
        return usageError(`new ${kind} takes one path.`, USAGE);
    }
    const type = parsed.values.type as string | undefined;
    if (kind !== 'connection' && type !== undefined) {
        return usageError('--type is for a connection only.', USAGE);
    }
    if (kind === 'connection' && type === undefined) {
        return usageError('A connection needs --type <type>.', USAGE);
    }
    if (type !== undefined && !CONNECTION_TYPES.some(t => t.type === type)) {
        return usageError(`Unknown connection type "${type}". The types: ${CONNECTION_TYPES.map(t => t.type).join(', ')}.`, USAGE);
    }

    const file = kind === 'project' ? join(path, 'project.yaml') : normalize(path);
    const target = resolve(cwd, file);
    const shown = slashed(file);
    if (existsSync(target)) {
        return { code: 1, output: `${shown} is already there.\n` };
    }
    const workspace = workspaceAbove(dirname(target));
    if (workspace === undefined) {
        return { code: 1, output: `${shown} is in no workspace: no folder above it has a workspace.yaml.\n` };
    }
    const root = dirname(workspace);
    const repoPath = slashed(relative(root, target));
    const entry = repoEntry(repoPath);
    if (entry.kind !== kind) {
        return { code: 1, output: `${shown} is not where a ${kind} lives: ${PLACES[kind]}.\n` };
    }

    const text = fileText(entry, type as ConnectionTypeName | undefined);
    const files = { ...readRepository(root).files, [repoPath]: text };
    // an invalid folder name above the file is reported on the folder's path
    const issues = validateWorkspaceTree({ workspace: entry.workspace, files }).errors.filter(
        i => i.path === repoPath || repoPath.startsWith(`${i.path}/`),
    );
    if (issues.length > 0) {
        return { code: 1, output: issues.map(i => `${i.path}: error: ${i.message}\n`).join('') };
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, { flag: 'wx' });
    return { code: 0, output: `Created ${shown}.\n` };
};
