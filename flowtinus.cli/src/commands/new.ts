import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { CONNECTION_TYPES, isConnectionType, newFlowFile, repoEntry, validateWorkspaceTree, type ConnectionTypeName, type RepoEntry } from '@flowtinus/core';
import { parseCommandArgs, usageError, type Command, type CommandResult } from '../command';
import { REPO_FILES } from '../repo-files';
import { readRepository, slashed } from '../repository';

const USAGE = 'Usage: flowtinus new flow <path> | new project <dir> | new connection <path> --type <type>';

type Given = { flow: object; project: object; connection: { type: ConnectionTypeName } };

type Kind = keyof Given;

type NewFile<K extends Kind> = {
    pathTemplate: string;
    text: (entry: Extract<RepoEntry, { kind: K }>, id: string, given: Given[K]) => string;
};

const NEW_FILES: { [K in Kind]: NewFile<K> } = {
    flow: {
        pathTemplate: '<workspace>/projects/<project>/flows/[<folder>/…]<name>.flow.yaml',
        text: (entry, id) => REPO_FILES.flow.write({ flow: newFlowFile(entry.name, id), deployed: true, schedules: [], webhooks: [] }),
    },
    project: {
        pathTemplate: '<workspace>/projects/<project>/project.yaml',
        text: (_entry, id) => REPO_FILES.project.write({ id, description: '' }),
    },
    connection: {
        pathTemplate: '<workspace>/connections/<name>.yaml',
        text: (_entry, id, { type }) => REPO_FILES.connection.write({ id, type }),
    },
};

type Request<K extends Kind = Kind> = { [P in K]: { kind: P; path: string; given: Given[P] } }[K];

const isKind = (kind: string | undefined): kind is Kind => kind !== undefined && kind in NEW_FILES;

const isEntryOf = <K extends Kind>(entry: RepoEntry, kind: K): entry is Extract<RepoEntry, { kind: K }> => entry.kind === kind;

const fileText = <K extends Kind>(request: Request<K>, entry: Extract<RepoEntry, { kind: K }>): string =>
    NEW_FILES[request.kind].text(entry, crypto.randomUUID(), request.given);

function parseRequest(args: string[]): Request | CommandResult {
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
    const { type } = parsed.values;
    if (kind !== 'connection') {
        return type === undefined ? { kind, path, given: {} } : usageError('--type is for a connection only.', USAGE);
    }
    if (type === undefined) {
        return usageError('A connection needs --type <type>.', USAGE);
    }
    if (!isConnectionType(type)) {
        return usageError(`Unknown connection type "${type}". The types: ${CONNECTION_TYPES.map(t => t.type).join(', ')}.`, USAGE);
    }
    return { kind, path, given: { type } };
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
    const request = parseRequest(args);
    if (!('kind' in request)) {
        return request;
    }
    const { kind, path } = request;
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
    const repository = readRepository(dirname(workspace));
    const repoPath = slashed(relative(repository.root, target));
    const entry = repoEntry(repoPath);
    if (!isEntryOf(entry, kind)) {
        return { code: 1, output: `${shown} is not where a ${kind} lives: ${NEW_FILES[kind].pathTemplate}.\n` };
    }

    const text = fileText(request, entry);
    const files = { ...repository.files, [repoPath]: text };
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
