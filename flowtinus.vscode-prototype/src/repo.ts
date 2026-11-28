// PROTOTYPE (#86): throwaway. The repo index the extension's features read: every file git would see, with the open
// editors' unsaved text over it, and the names behind the ids.
import { COMPONENTS, componentSettings, connectionFromYaml, connectionToYaml, hasComment, projectFromYaml, projectToYaml, repoEntry, repoFlowFromYaml, repoFlowToYaml, unknownKeyErrors, validateWorkspaceTree, workspaceFromYaml, workspaceToYaml, type RepoEntry, type RepoFileResult, type TreeValidation } from '../../flowtinus.core/src/index';
import { readRepository } from '../../flowtinus.core/src/disk/index';

export type Named = { id: string; name: string; path: string; type?: string };

export type Workspace = {
    name: string;
    connections: Map<string, Named>;
    flows: Map<string, Named>;
    validation: TreeValidation;
};

export type Index = { root: string; files: Record<string, string>; workspaces: Map<string, Workspace> };

const ID_LINE = /^id:\s*["']?([^\s"']+)/m;
const TYPE_LINE = /^type:\s*["']?([^\s"']+)/m;

export function buildIndex(folder: string, unsaved: Record<string, string>): Index {
    const repository = readRepository(folder);
    const files = { ...repository.files, ...unsaved };
    const workspaces = new Map<string, Workspace>();
    for (const name of repository.workspaces) {
        workspaces.set(name, {
            name,
            connections: new Map(),
            flows: new Map(),
            validation: validateWorkspaceTree({ workspace: name, files }),
        });
    }
    for (const [path, text] of Object.entries(files)) {
        const entry = repoEntry(path);
        const workspace = 'workspace' in entry ? workspaces.get(entry.workspace) : undefined;
        const id = text.match(ID_LINE)?.[1];
        if (!workspace || !id) {
            continue;
        }
        if (entry.kind === 'connection') {
            workspace.connections.set(id, { id, name: entry.name, path, type: text.match(TYPE_LINE)?.[1] });
        } else if (entry.kind === 'flow') {
            workspace.flows.set(id, { id, name: [...entry.folders, entry.name].join('/'), path, type: entry.project });
        }
    }
    return { root: repository.root, files, workspaces };
}

const repoFile = <T>(schema: string, read: (text: string, name: string) => RepoFileResult<T>, write: (value: T) => string) => ({
    format(text: string, name: string): RepoFileResult<string> {
        const result = read(text, name);
        if (!result.ok) {
            return result;
        }
        const unknown = unknownKeyErrors(text, schema);
        return unknown.length > 0 ? { ok: false, errors: unknown } : { ok: true, value: write(result.value) };
    },
});

const FORMATTERS = {
    workspace: repoFile('workspace.schema.json', workspaceFromYaml, workspaceToYaml),
    connection: repoFile('connection.schema.json', connectionFromYaml, connectionToYaml),
    project: repoFile('project.schema.json', projectFromYaml, projectToYaml),
    flow: repoFile('flow.schema.json', repoFlowFromYaml, ({ flow, ...triggers }) => repoFlowToYaml(flow, triggers)),
};

export function formatRepoFile(path: string, text: string): (RepoFileResult<string> & { droppedComment: boolean }) | undefined {
    const entry = repoEntry(path);
    if (!(entry.kind in FORMATTERS)) {
        return undefined;
    }
    const result = FORMATTERS[entry.kind as keyof typeof FORMATTERS].format(text, 'name' in entry ? entry.name : '');
    return { ...result, droppedComment: result.ok && result.value !== text && hasComment(text) };
}

export const workspaceOf = (path: string): string | undefined => {
    const entry: RepoEntry = repoEntry(path);
    return 'workspace' in entry ? entry.workspace : undefined;
};

/** the config keys that hold an id, per kind, over every component */
export const REFERENCE_KEYS = (() => {
    const keys = { connection: new Set<string>(), flow: new Set<string>(), script: new Set<string>() };
    for (const type of ['start', ...Object.keys(COMPONENTS)]) {
        for (const s of componentSettings(type)) {
            if (s.kind === 'connection') {
                keys.connection.add(s.key ?? 'connection');
            } else if (s.kind === 'flow') {
                keys.flow.add(s.key);
            } else if (s.kind === 'script-function') {
                keys.script.add(s.key);
            }
        }
    }
    return keys;
})();

export function acceptedConnectionTypes(componentType: string): string[] | undefined {
    const setting = componentSettings(componentType).find(s => s.kind === 'connection');
    return setting?.connectionTypes ?? (setting?.connectionType ? [setting.connectionType] : undefined);
}

export function ports(type: string, config: Record<string, unknown>): { inputs: number; outputs: string[] } {
    if (type === 'start') {
        return { inputs: 0, outputs: ['out-0'] };
    }
    if (type === 'end') {
        return { inputs: 1, outputs: [] };
    }
    const logic = COMPONENTS[type];
    const fromConfig = logic?.outputsFromConfig?.(config);
    const count = fromConfig?.length ?? logic?.outputs ?? 1;
    return { inputs: logic?.inputs ?? 1, outputs: [...Array.from({ length: count }, (_, i) => `out-${i}`), 'error'] };
}

export const componentLabel = (type: string) => COMPONENTS[type]?.label ?? type;
