import { connectionFromYaml, connectionToYaml, projectFromYaml, projectToYaml, repoFlowFromYaml, repoFlowToYaml, unknownKeyErrors, workspaceFromYaml, workspaceToYaml, type RepoFileResult } from '@flowtinus/core';

function repoFile<T>(schema: string, read: (text: string, name: string) => RepoFileResult<T>, write: (value: T) => string) {
    return {
        write,
        // a file with an unknown key is refused like one its reader refuses: rewriting it would drop the key
        format(text: string, name: string): RepoFileResult<string> {
            const result = read(text, name);
            if (!result.ok) {
                return result;
            }
            const unknown = unknownKeyErrors(text, schema);
            return unknown.length > 0 ? { ok: false, errors: unknown } : { ok: true, value: write(result.value) };
        },
    };
}

export const REPO_FILES = {
    workspace: repoFile('workspace.schema.json', workspaceFromYaml, workspaceToYaml),
    connection: repoFile('connection.schema.json', connectionFromYaml, connectionToYaml),
    project: repoFile('project.schema.json', projectFromYaml, projectToYaml),
    flow: repoFile('flow.schema.json', repoFlowFromYaml, ({ flow, ...triggers }) => repoFlowToYaml(flow, triggers)),
};

export type RepoFileKind = keyof typeof REPO_FILES;

export const isRepoFileKind = (kind: string): kind is RepoFileKind => kind in REPO_FILES;
