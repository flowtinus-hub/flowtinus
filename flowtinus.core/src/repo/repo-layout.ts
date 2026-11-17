export type RepoEntry =
    | { kind: 'gitattributes' }
    | { kind: 'workspace'; workspace: string }
    | { kind: 'connection'; workspace: string; name: string }
    | { kind: 'project'; workspace: string; project: string }
    | { kind: 'flow'; workspace: string; project: string; folders: string[]; name: string }
    | { kind: 'folder'; workspace: string; project: string; folders: string[] }
    | { kind: 'script'; workspace: string; project: string; path: string }
    | { kind: 'scriptFolder'; workspace: string; project: string; path: string }
    | { kind: 'unknown' };

const FLOW_SUFFIX = '.flow.yaml';
const SCRIPT_SUFFIX = '.ts';
const KEEP = '.gitkeep';

export function repoEntry(path: string): RepoEntry {
    if (path === '.gitattributes') {
        return { kind: 'gitattributes' };
    }
    const [workspace, area, ...rest] = path.split('/');
    if (!workspace || area === undefined) {
        return { kind: 'unknown' };
    }
    if (area === 'workspace.yaml' && rest.length === 0) {
        return { kind: 'workspace', workspace };
    }
    if (area === 'connections' && rest.length === 1 && rest[0]!.endsWith('.yaml') && rest[0]!.length > '.yaml'.length) {
        return { kind: 'connection', workspace, name: rest[0]!.slice(0, -'.yaml'.length) };
    }
    const [project, section, ...inside] = rest;
    if (area !== 'projects' || !project || section === undefined) {
        return { kind: 'unknown' };
    }
    const file = inside[inside.length - 1];
    const folders = inside.slice(0, -1);
    if (section === 'project.yaml' && inside.length === 0) {
        return { kind: 'project', workspace, project };
    }
    if (section === 'flows' && file?.endsWith(FLOW_SUFFIX) && file.length > FLOW_SUFFIX.length) {
        return { kind: 'flow', workspace, project, folders, name: file.slice(0, -FLOW_SUFFIX.length) };
    }
    if (section === 'flows' && file === KEEP && folders.length > 0) {
        return { kind: 'folder', workspace, project, folders };
    }
    if (section === 'scripts' && file?.endsWith(SCRIPT_SUFFIX) && file.length > SCRIPT_SUFFIX.length) {
        return { kind: 'script', workspace, project, path: [...folders, file.slice(0, -SCRIPT_SUFFIX.length)].join('/') };
    }
    if (section === 'scripts' && file === KEEP && folders.length > 0) {
        return { kind: 'scriptFolder', workspace, project, path: folders.join('/') };
    }
    return { kind: 'unknown' };
}
