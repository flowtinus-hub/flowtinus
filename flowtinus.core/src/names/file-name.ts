import { folderPath, type TreeContents } from '../folders/folder-tree';

// 150 in the repo leaves 109 of Windows' 259 for the clone's own folder (C:\Users\<user>\source\repos\<repo>\)
export const NAME_MAX = 64;
export const REPO_PATH_MAX = 150;

export type NameKind = 'project' | 'folder' | 'flow' | 'connection' | 'script';

const FORBIDDEN = /[\\/:*?"<>|]/;
const CONTROL = /\p{Cc}/u;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const FLOW_FILE = '.flow.yaml';

export const nameKey = (name: string) => name.normalize('NFC').toLowerCase();

export function fileNameIssue(name: string, kind?: NameKind): string | undefined {
    if (name === '') {
        return 'Required';
    }
    if (name.length > NAME_MAX) {
        return `At most ${NAME_MAX} characters`;
    }
    if (name === '.' || name === '..') {
        return 'Not "." or ".."';
    }
    if (FORBIDDEN.test(name)) {
        return 'None of \\ / : * ? " < > |';
    }
    if (CONTROL.test(name)) {
        return 'No control characters';
    }
    if (/^\s|\s$/.test(name)) {
        return 'No space at the start or the end';
    }
    if (name.endsWith('.')) {
        return 'Not ending in a dot';
    }
    // Windows reserves the name whatever follows its first dot, and ignores spaces before that dot
    const base = name.split('.')[0]!.trimEnd();
    if (WINDOWS_RESERVED.test(base)) {
        return `"${base}" is a name Windows reserves`;
    }
    if (kind === 'folder' && name.toLowerCase().endsWith(FLOW_FILE)) {
        return `A folder name cannot end in ${FLOW_FILE}`;
    }
    return undefined;
}

export function validateName(name: string, siblings: { name: string }[], kind?: NameKind): { value: string; error?: string } {
    const value = name.trim().normalize('NFC');
    const issue = fileNameIssue(value, kind);
    if (issue) {
        return { value, error: issue };
    }
    const key = nameKey(value);
    return siblings.some(sibling => nameKey(sibling.name) === key) ? { value, error: 'Already in use' } : { value };
}

export const repoPath = {
    gitattributes: '.gitattributes',
    workspace: (workspace: string) => `${workspace}/workspace.yaml`,
    connection: (workspace: string, name: string) => `${workspace}/connections/${name}.yaml`,
    project: (workspace: string, project: string) => `${workspace}/projects/${project}/project.yaml`,
    flow: (workspace: string, project: string, folders: string[], flow: string) =>
        [workspace, 'projects', project, 'flows', ...folders, `${flow}${FLOW_FILE}`].join('/'),
    folder: (workspace: string, project: string, folders: string[]) =>
        [workspace, 'projects', project, 'flows', ...folders, '.gitkeep'].join('/'),
    script: (workspace: string, project: string, path: string) => `${workspace}/projects/${project}/scripts/${path}.ts`,
    scriptFolder: (workspace: string, project: string, path: string) => `${workspace}/projects/${project}/scripts/${path}/.gitkeep`,
};

export type ProjectScripts = { scripts: string[]; folders: string[] };

/** every path an active project gives in the repo; an empty folder is kept by its .gitkeep */
export function projectRepoPaths(
    workspace: string,
    project: string,
    tree: TreeContents,
    scripts: ProjectScripts = { scripts: [], folders: [] },
): string[] {
    const active = (item: { archivedAt: unknown }) => item.archivedAt === null || item.archivedAt === undefined;
    const visible = (folderId: string | null) => folderPath(tree.folders, folderId).every(active);
    const names = (folderId: string | null) => folderPath(tree.folders, folderId).map(f => f.name);
    const flows = tree.flows.filter(f => active(f) && visible(f.folderId));
    const folders = tree.folders.filter(f => visible(f.id));
    const emptyFolders = folders.filter(f => !folders.some(c => c.parentId === f.id) && !flows.some(w => w.folderId === f.id));
    const emptyScriptFolders = scripts.folders.filter(
        folder => ![...scripts.scripts, ...scripts.folders].some(path => path.startsWith(`${folder}/`)),
    );
    return [
        repoPath.project(workspace, project),
        ...flows.map(f => repoPath.flow(workspace, project, names(f.folderId), f.name)),
        ...emptyFolders.map(f => repoPath.folder(workspace, project, names(f.id))),
        ...scripts.scripts.map(path => repoPath.script(workspace, project, path)),
        ...emptyScriptFolders.map(path => repoPath.scriptFolder(workspace, project, path)),
    ];
}

export function repoPathIssue(paths: string[]): string | undefined {
    const longest = paths.reduce<string | undefined>((max, path) => (path.length > (max?.length ?? REPO_PATH_MAX) ? path : max), undefined);
    return longest === undefined
        ? undefined
        : `The path "${longest}" in the repository would have ${longest.length} characters (at most ${REPO_PATH_MAX})`;
}

/** a path whose folders or name differ only in case or normalization from what is already there: a case-insensitive disk holds one */
export function pathCaseClash(path: string, existing: string[]): string | undefined {
    const known = new Map<string, string>();
    for (const other of existing) {
        const parts = other.split('/');
        parts.forEach((_, i) => {
            const prefix = parts.slice(0, i + 1).join('/');
            known.set(nameKey(prefix), prefix);
        });
    }
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
        const prefix = parts.slice(0, i + 1).join('/');
        const other = known.get(nameKey(prefix));
        if (other !== undefined && other !== prefix) {
            return `"${prefix}" differs only in case from "${other}"`;
        }
    }
    return undefined;
}
