import { fileNameIssue } from '../names/file-name';

/** every import path starts with it: `@w/<workspace handle>/<project handle>/scripts/<path>` */
export const SCRIPT_IMPORT_ROOT = '@w/';
export const MAX_SCRIPT_PATH = 200;

const PART = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const normalizeScriptPath = (text: string): string =>
    text
        .trim()
        .replaceAll('\\', '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\.ts$/i, '');

export function scriptPathIssue(path: string): string | null {
    if (!path) {
        return 'The path is empty.';
    }
    if (path.length > MAX_SCRIPT_PATH) {
        return `The path is longer than ${MAX_SCRIPT_PATH} characters.`;
    }
    const bad = path.split('/').find(part => !PART.test(part));
    if (bad !== undefined) {
        return bad === ''
            ? 'The path has an empty folder (two slashes together).'
            : `"${bad}" is not a valid name: use letters, numbers, - and _ (starting with a letter or a number).`;
    }
    for (const part of path.split('/')) {
        const issue = fileNameIssue(part, 'script');
        if (issue) {
            return `"${part}": ${issue}.`;
        }
    }
    return null;
}

export type ScriptAddress = { workspace: string; project: string; path: string };

export const scriptImportPrefix = (workspace: string, project: string) => `${SCRIPT_IMPORT_ROOT}${workspace}/${project}/scripts/`;

export const scriptImport = (workspace: string, project: string, path: string) => `${scriptImportPrefix(workspace, project)}${path}`;

export function scriptAddress(importPath: string): ScriptAddress | null {
    const match = /^@w\/([^/]+)\/([^/]+)\/scripts\/(.+)$/.exec(importPath);
    return match ? { workspace: match[1]!, project: match[2]!, path: match[3]! } : null;
}

export const scriptModuleUri = (importPath: string) => `file:///${importPath.slice(1)}.ts`;

export function scriptImportOfModule(uri: string): string | null {
    const match = /^file:\/\/\/(w\/.+)\.ts$/.exec(uri);
    return match && scriptAddress(`@${match[1]}`) ? `@${match[1]}` : null;
}

const IMPORT_OF = String.raw`((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"]))(@w\/[^'"]+)\2`;

/** the import paths of the scripts some code imports, whatever their workspace */
export function scriptImports(code: string): string[] {
    return [...new Set([...code.matchAll(new RegExp(IMPORT_OF, 'g'))].map(match => match[3]!))];
}

/** the code with its imports of scripts under `from` (the import path of a script or a folder) moved to `to` */
export function movedScriptImports(code: string, from: string, to: string): string {
    return code.replace(new RegExp(IMPORT_OF, 'g'), (whole, head: string, quote: string, path: string) =>
        insideScriptFolder(path, from) ? `${head}${movedScriptPath(path, from, to)}${quote}` : whole,
    );
}

export const insideScriptFolder = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

export const movedScriptPath = (path: string, from: string, to: string) =>
    insideScriptFolder(path, from) ? `${to}${path.slice(from.length)}` : path;

export type ScriptExport = { name: string; typeOnly: boolean; function?: true };

export function scriptExports(code: string): ScriptExport[] {
    const found = new Map<string, ScriptExport>();
    const pattern =
        /^[ \t]*export[ \t]+(?:declare[ \t]+)?(interface|type|(?:async[ \t]+)?function\*?|const|let|var|(?:abstract[ \t]+)?class|enum)[ \t]+([A-Za-z_$][\w$]*)/gm;
    for (const match of code.matchAll(pattern)) {
        const name = match[2]!;
        if (!found.has(name)) {
            found.set(name, {
                name,
                typeOnly: match[1] === 'interface' || match[1] === 'type',
                ...(/function/.test(match[1]!) ? { function: true as const } : {}),
            });
        }
    }
    // export { a, b as c } (not re-exports from elsewhere: those are another script's)
    for (const match of code.matchAll(/^[ \t]*export[ \t]+(type[ \t]+)?\{([^}]*)\}(?![ \t]*from)/gm)) {
        for (const part of match[2]!.split(',')) {
            const name = part
                .trim()
                .split(/\s+as\s+/)
                .at(-1)
                ?.trim();
            if (name && /^[A-Za-z_$][\w$]*$/.test(name) && !found.has(name)) {
                found.set(name, { name, typeOnly: Boolean(match[1]) });
            }
        }
    }
    return [...found.values()];
}

export const scriptImportLine = (importPath: string, name: string, typeOnly: boolean) =>
    `import ${typeOnly ? 'type ' : ''}{ ${name} } from '${importPath}';`;

export function boundNames(code: string): Set<string> {
    const names = new Set<string>();
    const id = String.raw`[A-Za-z_$][\w$]*`;
    for (const match of code.matchAll(/^[ \t]*import\s+(?:type\s+)?([^'";]*?)\s+from\s*['"][^'"]+['"]/gm)) {
        const clause = match[1]!;
        const braces = /\{([^}]*)\}/.exec(clause);
        for (const part of braces?.[1]?.split(',') ?? []) {
            const name = part
                .replace(/^\s*type\s+/, '')
                .trim()
                .split(/\s+as\s+/)
                .at(-1)
                ?.trim();
            if (name && new RegExp(`^${id}$`).test(name)) {
                names.add(name);
            }
        }
        const outside = clause.replace(/\{[^}]*\}/, '');
        for (const name of outside.matchAll(new RegExp(id, 'g'))) {
            if (name[0] !== 'type' && name[0] !== 'as') {
                names.add(name[0]);
            }
        }
    }
    const declared = new RegExp(String.raw`\b(?:interface|type|(?:async\s+)?function\*?|class|enum|const|let|var)\s+(` + id + ')', 'g');
    for (const match of code.matchAll(declared)) {
        names.add(match[1]!);
    }
    return names;
}

export const MAX_SCRIPT_BYTES = 1024 * 1024;

export function scriptContentIssue(content: string): string | null {
    const bytes = new TextEncoder().encode(content).length;
    return bytes > MAX_SCRIPT_BYTES
        ? `The script takes ${(bytes / 1024 / 1024).toFixed(1)} MB (at most ${MAX_SCRIPT_BYTES / 1024 / 1024} MB).`
        : null;
}

export function scriptClosure(
    code: string,
    scripts: Record<string, string>,
): { paths: string[]; missing: { from: string | null; path: string }[] } {
    const paths = new Set<string>();
    const missing: { from: string | null; path: string }[] = [];
    const visit = (source: string, from: string | null) => {
        for (const path of scriptImports(source)) {
            if (!(path in scripts)) {
                missing.push({ from, path });
            } else if (!paths.has(path)) {
                paths.add(path);
                visit(scripts[path]!, path);
            }
        }
    };
    visit(code, null);
    return { paths: [...paths].sort(), missing };
}
