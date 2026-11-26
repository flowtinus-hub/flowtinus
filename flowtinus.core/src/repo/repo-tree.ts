import { parse, parseDocument, visit } from 'yaml';
import { startConfig } from '../components/built-in/start';
import { START } from '#engine/constants';
import { toExecutableFlow, type FlowFile } from '../flows/flow-file';
import { flowResources } from '../flows/flow-resources';
import { fileNameIssue, nameKey, REPO_PATH_MAX, type NameKind } from '../names/file-name';
import { handleOf, handleTakenMessage } from '../names/handle';
import { scriptImport, scriptPathIssue } from '../scripts/script-path';
import { cronError } from '../triggers/triggers';
import { flowCalls, flowScriptUses, scriptLinks } from '../validation/flow-dependencies';
import { connectionFromYaml, isRepoId, projectFromYaml, repoFlowFromYaml, workspaceFromYaml, type RepoFileResult, type RepoFlow } from './repo-files';
import { repoEntry } from './repo-layout';
import { REPO_SCHEMAS } from './repo-schemas';

export type WorkspaceTree = {
    workspace: string;
    files: Record<string, string>;
    // none without a server (the CLI): the warnings only a server can give are left out
    environment?: { connections: string[]; secrets: string[]; variables: string[] };
    archivedProjects?: string[];
};

export type TreeIssue = { path: string; message: string };

export type TreeValidation = { errors: TreeIssue[]; warnings: TreeIssue[] };

type Schema = { properties?: Record<string, Schema>; additionalProperties?: boolean; items?: Schema };

const schemaOf = (file: string) => REPO_SCHEMAS.find(s => s.file === file)!.schema as Schema;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function yamlOf(text: string): unknown {
    try {
        return parse(text);
    } catch {
        return undefined;
    }
}

function unknownKeys(value: unknown, schema: Schema, at = ''): string[] {
    if (Array.isArray(value)) {
        return schema.items ? value.flatMap((item, i) => unknownKeys(item, schema.items!, `${at}[${i}]`)) : [];
    }
    if (!isObject(value) || !schema.properties) {
        return [];
    }
    return Object.entries(value).flatMap(([key, item]) => {
        const path = at ? `${at}.${key}` : key;
        const inner = schema.properties![key];
        return inner ? unknownKeys(item, inner, path) : schema.additionalProperties === false ? [path] : [];
    });
}

export function hasComment(text: string): boolean {
    const doc = parseDocument(text);
    let found = Boolean(doc.commentBefore || doc.comment);
    visit(doc, (_key, node) => {
        const { commentBefore, comment } = node as { commentBefore?: string | null; comment?: string | null };
        if (commentBefore || comment) {
            found = true;
            return visit.BREAK;
        }
        return undefined;
    });
    return found;
}

export function validateWorkspaceTree({ workspace, files, environment, archivedProjects = [] }: WorkspaceTree): TreeValidation {
    const errors: TreeIssue[] = [];
    const warnings: TreeIssue[] = [];
    const read = <T>(path: string, result: RepoFileResult<T>, schema: string): T | undefined => {
        if (!result.ok) {
            errors.push(...result.errors.map(message => ({ path, message })));
            return undefined;
        }
        errors.push(...unknownKeys(yamlOf(files[path]!), schemaOf(schema)).map(key => ({ path, message: `Unknown key "${key}".` })));
        return result.value;
    };

    const ids = { connection: new Map<string, string>(), project: new Map<string, string>(), flow: new Map<string, string>() };
    // the id of a file its reader refuses still counts: what refers to it is not in error too
    const identify = (kind: keyof typeof ids, path: string) => {
        const data = yamlOf(files[path]!);
        const id = isObject(data) && typeof data.id === 'string' && data.id !== '' ? data.id : undefined;
        if (id === undefined) {
            return;
        }
        if (!isRepoId(id)) {
            errors.push({ path, message: `The id "${id}" is not a UUID in lower case.` });
        }
        const first = ids[kind].get(id);
        if (first === undefined) {
            ids[kind].set(id, path);
        } else {
            errors.push({ path, message: `The id "${id}" is also in ${first}.` });
        }
    };

    const triggers = new Map<string, string>();
    const checkTriggers = (path: string, { flow, schedules, webhooks }: RepoFlow) => {
        const all = [...schedules.map(t => ['schedule', t] as const), ...webhooks.map(t => ['webhook', t] as const)];
        for (const [kind, { id }] of all) {
            const first = triggers.get(id);
            if (first !== undefined) {
                const where = first === path ? 'used more than once in this file' : `also in ${first}`;
                errors.push({ path, message: `The ${kind} id "${id}" is ${where}.` });
            }
            triggers.set(id, first ?? path);
            if (!isRepoId(id)) {
                errors.push({ path, message: `The ${kind} id "${id}" is not a UUID in lower case.` });
            }
        }
        const start = startConfig(flow.nodes.find(n => n.type === START)?.config ?? {});
        for (const { id, cron, timezone, parameters, input } of schedules) {
            const issue = cronError(cron, timezone);
            if (issue) {
                errors.push({ path, message: `Schedule ${id}: ${issue}` });
            }
            for (const name of Object.keys(parameters).filter(name => !start.parameters.some(p => p.name === name))) {
                warnings.push({ path, message: `Schedule ${id} gives the parameter "${name}", which the Start does not declare.` });
            }
            if (input !== undefined && !start.acceptsInput) {
                warnings.push({ path, message: `Schedule ${id} gives an input, which the Start does not take.` });
            }
        }
    };

    const flows: { path: string; project: string; flow: FlowFile }[] = [];
    const scripts = new Map<string, { path: string; content: string }>();

    const workspaceFile = `${workspace}/workspace.yaml`;
    if (!(workspaceFile in files)) {
        errors.push({ path: workspaceFile, message: 'The workspace has no workspace.yaml.' });
    }
    const checked = new Set<string>();
    const checkName = (where: string, name: string, kind: NameKind) => {
        const issue = checked.has(where) ? undefined : fileNameIssue(name, kind);
        checked.add(where);
        if (issue) {
            errors.push({ path: where, message: `The ${kind} name "${name}" is not valid: ${issue}.` });
        }
    };
    const checkScriptPath = (where: string, scriptPath: string) => {
        const issue = scriptPathIssue(scriptPath);
        if (issue) {
            errors.push({ path: where, message: `The script path "${scriptPath}" is not valid: ${issue}` });
        }
    };
    const seen = new Map<string, string>();
    const clashed = new Set<string>();
    const checkCase = (path: string) => {
        const parts = path.split('/');
        for (let i = 1; i <= parts.length; i++) {
            const prefix = parts.slice(0, i).join('/');
            const other = seen.get(nameKey(prefix));
            if (other === undefined) {
                seen.set(nameKey(prefix), prefix);
            } else if (other !== prefix && !clashed.has(prefix)) {
                clashed.add(prefix);
                const how = prefix.normalize('NFC') === other.normalize('NFC') ? 'Unicode normalization' : 'case';
                errors.push({ path: prefix, message: `It differs only in ${how} from "${other}".` });
            }
        }
    };

    const projects = new Set<string>();
    for (const [path, text] of Object.entries(files)) {
        const entry = repoEntry(path);
        if (entry.kind !== 'gitattributes' && !path.startsWith(`${workspace}/`)) {
            continue;
        }
        if ('project' in entry) {
            projects.add(entry.project);
            checkName(`${workspace}/projects/${entry.project}`, entry.project, 'project');
        }
        if ('folders' in entry) {
            entry.folders.forEach((folder, i) =>
                checkName([workspace, 'projects', entry.project, 'flows', ...entry.folders.slice(0, i + 1)].join('/'), folder, 'folder'),
            );
        }
        checkCase(path);
        if (path.length > REPO_PATH_MAX) {
            errors.push({
                path,
                message: `The path has ${path.length} characters (at most ${REPO_PATH_MAX}), too long for a clone on Windows.`,
            });
        }

        if (entry.kind === 'workspace') {
            read(path, workspaceFromYaml(text), 'workspace.schema.json');
        } else if (entry.kind === 'connection') {
            checkName(path, entry.name, 'connection');
            const connection = read(path, connectionFromYaml(text), 'connection.schema.json');
            identify('connection', path);
            if (connection && environment && !environment.connections.includes(connection.id)) {
                warnings.push({ path, message: `The connection "${entry.name}" is not configured on this server.` });
            }
        } else if (entry.kind === 'project') {
            read(path, projectFromYaml(text), 'project.schema.json');
            identify('project', path);
        } else if (entry.kind === 'flow') {
            checkName(path, entry.name, 'flow');
            const repoFlow = read(path, repoFlowFromYaml(text, entry.name), 'flow.schema.json');
            identify('flow', path);
            if (repoFlow) {
                flows.push({ path, project: entry.project, flow: repoFlow.flow });
                checkTriggers(path, repoFlow);
                if (hasComment(text)) {
                    warnings.push({
                        path,
                        message: "It has a comment, which the app's next save drops: a node's notes keep what a comment would.",
                    });
                }
            }
        } else if (entry.kind === 'script') {
            checkScriptPath(path, entry.path);
            scripts.set(scriptImport(workspace, handleOf(entry.project), entry.path), { path, content: text });
        } else if (entry.kind === 'scriptFolder') {
            checkScriptPath(path, entry.path);
        } else if (entry.kind === 'unknown') {
            warnings.push({ path, message: 'It is not part of the repository format: it is left out.' });
        }
    }
    if (!('.gitattributes' in files)) {
        warnings.push({
            path: '.gitattributes',
            message: 'The repository has no .gitattributes: a clone on Windows may get CRLF line endings.',
        });
    }

    for (const project of projects) {
        const path = `${workspace}/projects/${project}/project.yaml`;
        if (!(path in files)) {
            errors.push({ path, message: 'The project has no project.yaml (it holds its id).' });
        }
    }
    const holders = new Map(archivedProjects.map(name => [handleOf(name), { name, archived: true }]));
    for (const project of projects) {
        const handle = handleOf(project);
        const holder = holders.get(handle);
        if (fileNameIssue(project, 'project')) {
            continue;
        }
        if (!holder) {
            holders.set(handle, { name: project, archived: false });
        } else if (holder.archived || nameKey(holder.name) !== nameKey(project)) {
            errors.push({ path: `${workspace}/projects/${project}`, message: handleTakenMessage(project, holder) });
        }
    }
    for (const { path, project, flow } of flows) {
        const executable = toExecutableFlow(flow, project);
        for (const call of flowCalls([executable]).filter(c => !ids.flow.has(c.to))) {
            errors.push({ path, message: `Node "${call.nodeId}" calls the flow "${call.to}", which is not in the workspace.` });
        }
        for (const use of flowScriptUses([executable]).filter(u => !scripts.has(u.path))) {
            errors.push({ path, message: `Node "${use.nodeId}" uses the script "${use.path}", which is not in the workspace.` });
        }
        for (const node of flow.nodes) {
            for (const id of flowResources({ ...flow, nodes: [node] }).connectionIds.filter(id => !ids.connection.has(id))) {
                errors.push({
                    path,
                    message: `Node "${node.id}" uses the connection "${id}", which is not declared in ${workspace}/connections.`,
                });
            }
        }
        if (environment) {
            const { secrets, variables } = flowResources(flow);
            for (const name of secrets.filter(name => !environment.secrets.includes(name))) {
                warnings.push({ path, message: `The secret "${name}" has no value on this server.` });
            }
            for (const name of variables.filter(name => !environment.variables.includes(name))) {
                warnings.push({ path, message: `The variable "${name}" has no value on this server.` });
            }
        }
    }
    for (const link of scriptLinks([...scripts].map(([path, s]) => ({ path, content: s.content }))).filter(l => !scripts.has(l.to))) {
        errors.push({
            path: scripts.get(link.from)!.path,
            message: `It imports the script "${link.to}", which is not in the workspace.`,
        });
    }
    return { errors, warnings };
}
