import YAML from 'yaml';

export const WS = 'acme';

export type Tree = Record<string, string>;
export type Overlay = Record<string, string | null>;

export type CommitKind = 'initial' | 'commit' | 'merge' | 'promotion' | 'backport' | 'update' | 'outside';
export type Commit = { sha: string; parents: string[]; message: string; author: string; at: number; tree: Tree; kind: CommitKind };

export type PrKind = 'change' | 'promotion' | 'backport';
export type Pr = {
    number: number;
    kind: PrKind;
    from: string;
    to: string;
    title: string;
    state: 'open' | 'merged' | 'closed';
    openedOn: string;
    author: string;
    mergeSha?: string;
};

export type GitSettings = { repo: string; branch: string; directEdits: boolean; credential: string; promotesTo: string[] };

export type Version = { n: number; sha: string | null; message: string; hash: string; deployedField: boolean; at: number };
export type FlowRow = { id: string; name: string; versions: Version[]; current: number | null };
export type ScheduleDefaults = { cron: string; timezone: string; parameters: string; input: string };
export type ScheduleRow = { id: string; flowId: string; enabled: boolean; override: Partial<ScheduleDefaults> };
export type ConnectionRow = { id: string; name: string; type: string; configured: boolean };

export type Server = {
    env: string;
    gitOn: boolean;
    settings: GitSettings;
    reconciledSha: string | null;
    flows: Record<string, FlowRow>;
    schedules: Record<string, ScheduleRow>;
    connections: Record<string, ConnectionRow>;
    scripts: Record<string, string>;
    working: Record<string, Overlay>;
    history: string[];
};

export type User = { slug: string; name: string };
export type Event = { id: number; at: number; text: string; tone: 'ok' | 'warn' | 'error' | 'info' };

export type State = {
    seq: number;
    clock: number;
    commits: Record<string, Commit>;
    branches: Record<string, string>;
    branchMeta: Record<string, { cutFrom?: string; owner?: string; createdOn?: string }>;
    prs: Pr[];
    servers: Record<string, Server>;
    envOrder: string[];
    users: User[];
    secrets: string[];
    session: { env: string; user: string; branchByEnvUser: Record<string, string>; variant: string };
    events: Event[];
};

export const POSTGRES = '__postgres__';

export function shortHash(text: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x1234567;
    for (let i = 0; i < text.length; i++) {
        h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619);
        h2 = Math.imul(h2 ^ text.charCodeAt(i), 2246822519);
    }
    return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 7);
}

export function ancestors(state: State, sha: string | undefined): Set<string> {
    const seen = new Set<string>();
    const stack = sha ? [sha] : [];
    while (stack.length) {
        const next = stack.pop()!;
        if (seen.has(next)) {
            continue;
        }
        seen.add(next);
        stack.push(...(state.commits[next]?.parents ?? []));
    }
    return seen;
}

export function isAncestor(state: State, maybe: string, of: string): boolean {
    return ancestors(state, of).has(maybe);
}

/** commits reachable from `tip` and not from `base`, newest first */
export function commitsBetween(state: State, base: string | undefined, tip: string | undefined): Commit[] {
    const exclude = ancestors(state, base);
    return [...ancestors(state, tip)]
        .filter(sha => !exclude.has(sha))
        .map(sha => state.commits[sha]!)
        .sort((a, b) => b.at - a.at);
}

export function mergeBase(state: State, a: string, b: string): string | null {
    const left = ancestors(state, a);
    const common = [...ancestors(state, b)].filter(sha => left.has(sha));
    const best = common.filter(c => !common.some(other => other !== c && ancestors(state, other).has(c)));
    best.sort((x, y) => state.commits[y]!.at - state.commits[x]!.at);
    return best[0] ?? null;
}

export function threeWay(base: Tree, ours: Tree, theirs: Tree): { tree: Tree; conflicts: string[] } {
    const tree: Tree = {};
    const conflicts: string[] = [];
    const paths = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
    for (const path of paths) {
        const b = base[path];
        const o = ours[path];
        const t = theirs[path];
        let result: string | undefined;
        if (o === t) {
            result = o;
        } else if (o === b) {
            result = t;
        } else if (t === b) {
            result = o;
        } else {
            conflicts.push(path);
            result = o;
        }
        if (result !== undefined) {
            tree[path] = result;
        }
    }
    return { tree, conflicts: conflicts.sort() };
}

export function applyOverlay(tree: Tree, overlay: Overlay | undefined): Tree {
    const out: Tree = { ...tree };
    for (const [path, content] of Object.entries(overlay ?? {})) {
        if (content === null) {
            delete out[path];
        } else {
            out[path] = content;
        }
    }
    return out;
}

export type Change = {
    key: string;
    path: string;
    from?: string;
    status: 'added' | 'modified' | 'deleted' | 'renamed';
    before?: string;
    after?: string;
};

const identity = (content: string) => /^id: (.+)$/m.exec(content)?.[1] ?? `content:${content}`;

export function changesBetween(before: Tree, after: Tree): Change[] {
    const added: string[] = [];
    const deleted: string[] = [];
    const changes: Change[] = [];
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const b = before[path];
        const a = after[path];
        if (b === a) {
            continue;
        }
        if (b === undefined) {
            added.push(path);
        } else if (a === undefined) {
            deleted.push(path);
        } else {
            changes.push({ key: path, path, status: 'modified', before: b, after: a });
        }
    }
    for (const path of added) {
        const id = identity(after[path]!);
        const fromIndex = deleted.findIndex(d => identity(before[d]!) === id);
        if (fromIndex >= 0) {
            const from = deleted.splice(fromIndex, 1)[0]!;
            changes.push({ key: `${from}->${path}`, path, from, status: 'renamed', before: before[from]!, after: after[path]! });
        } else {
            changes.push({ key: path, path, status: 'added', after: after[path]! });
        }
    }
    for (const path of deleted) {
        changes.push({ key: path, path, status: 'deleted', before: before[path]! });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export type DiffLine = { kind: ' ' | '+' | '-'; text: string };

export function diffLines(before: string, after: string): DiffLine[] {
    const a = before === '' ? [] : before.split('\n');
    const b = after === '' ? [] : after.split('\n');
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
        }
    }
    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            out.push({ kind: ' ', text: a[i]! });
            i++;
            j++;
        } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
            out.push({ kind: '-', text: a[i++]! });
        } else {
            out.push({ kind: '+', text: b[j++]! });
        }
    }
    while (i < a.length) {
        out.push({ kind: '-', text: a[i++]! });
    }
    while (j < b.length) {
        out.push({ kind: '+', text: b[j++]! });
    }
    return out;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i;

export function nameProblem(name: string, kind: string): string | null {
    if (name === '') {
        return `The ${kind} needs a name.`;
    }
    if (name === '.' || name === '..') {
        return `"${name}" cannot be a ${kind} name.`;
    }
    const bad = name.match(/[\\/:*?"<>|]/g);
    if (bad) {
        return `A ${kind} name cannot contain ${[...new Set(bad)].join(' ')} (the name is a file or folder in git, on every OS).`;
    }
    if (/\p{Cc}/u.test(name)) {
        return `A ${kind} name cannot contain control characters.`;
    }
    if (name !== name.trim()) {
        return `A ${kind} name cannot start or end with a space.`;
    }
    if (name.endsWith('.')) {
        return `A ${kind} name cannot end with a dot (Windows drops it).`;
    }
    if (RESERVED.test(name)) {
        return `"${name}" is reserved by Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9, also with an extension).`;
    }
    return null;
}

export function scriptPathProblem(path: string): string | null {
    const segments = path.split('/');
    for (const segment of segments) {
        const problem = nameProblem(segment, 'script path segment');
        if (problem) {
            return problem;
        }
    }
    return null;
}

export type Node = { id: string; type: string; label?: string; position: { x: number; y: number }; config?: Record<string, unknown> };
export type ScheduleDoc = { id: string; name: string } & ScheduleDefaults;
export type FlowDoc = { id: string; deployed: boolean; workerTag: string; nodes: Node[]; edges: string[]; schedules?: ScheduleDoc[] };

export const flowYaml = (doc: FlowDoc) => YAML.stringify(doc, { lineWidth: 0 });
export const parseFlow = (content: string) => YAML.parse(content) as FlowDoc;

export type FlowItem = { id: string; name: string; project: string; folder: string; path: string; doc: FlowDoc };
export type ScriptItem = { project: string; rel: string; path: string; content: string };
export type ProjectItem = { name: string; path: string; meta: { id: string; description: string; color: string }; folders: string[] };
export type ConnectionDecl = { id: string; name: string; type: string };
export type WorkspaceView = { connections: ConnectionDecl[]; projects: ProjectItem[]; flows: FlowItem[]; scripts: ScriptItem[] };

export const workspaceFile = `${WS}/workspace.yaml`;
export const projectDir = (project: string) => `${WS}/${project}`;
export const flowFile = (project: string, folder: string, name: string) =>
    `${WS}/${project}/flows/${folder ? `${folder}/` : ''}${name}.yaml`;
export const scriptFile = (project: string, rel: string) => `${WS}/${project}/scripts/${rel}`;

export function parseWorkspace(tree: Tree): WorkspaceView {
    const view: WorkspaceView = { connections: [], projects: [], flows: [], scripts: [] };
    const ws = tree[workspaceFile];
    if (ws) {
        view.connections = (YAML.parse(ws) as { connections?: ConnectionDecl[] }).connections ?? [];
    }
    const folders = new Map<string, Set<string>>();
    for (const [path, content] of Object.entries(tree)) {
        const parts = path.split('/');
        if (parts[0] !== WS || parts.length < 3) {
            continue;
        }
        const project = parts[1]!;
        if (!folders.has(project)) {
            folders.set(project, new Set());
        }
        if (parts.length === 3 && parts[2] === 'project.yaml') {
            view.projects.push({ name: project, path: `${WS}/${project}`, meta: YAML.parse(content) as ProjectItem['meta'], folders: [] });
        } else if (parts[2] === 'flows') {
            const rest = parts.slice(3);
            const file = rest.pop()!;
            for (let i = 1; i <= rest.length; i++) {
                folders.get(project)!.add(rest.slice(0, i).join('/'));
            }
            if (file.endsWith('.yaml')) {
                const doc = parseFlow(content);
                view.flows.push({ id: doc.id, name: file.slice(0, -5), project, folder: rest.join('/'), path, doc });
            }
        } else if (parts[2] === 'scripts') {
            view.scripts.push({ project, rel: parts.slice(3).join('/'), path, content });
        }
    }
    for (const project of view.projects) {
        project.folders = [...(folders.get(project.name) ?? [])].sort();
    }
    view.projects.sort((a, b) => a.name.localeCompare(b.name));
    view.flows.sort((a, b) => a.path.localeCompare(b.path));
    view.scripts.sort((a, b) => a.path.localeCompare(b.path));
    return view;
}

export const sameName = (a: string, b: string) => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();

export function sourceOf(state: State, env: string): string | null {
    const branch = state.servers[env]!.settings.branch;
    return state.envOrder.find(other => other !== env && state.servers[other]!.settings.promotesTo.includes(branch)) ?? null;
}

export function envOfBranch(state: State, branch: string): string | null {
    return state.envOrder.find(env => state.servers[env]!.settings.branch === branch) ?? null;
}

export function aheadOfSource(state: State, env: string): Commit[] {
    const source = sourceOf(state, env);
    if (!source) {
        return [];
    }
    const tip = state.branches[state.servers[env]!.settings.branch];
    const sourceTip = state.branches[state.servers[source]!.settings.branch];
    return commitsBetween(state, sourceTip, tip).filter(c => c.kind !== 'promotion' && c.kind !== 'backport');
}

export const isUserBranch = (branch: string) => branch.startsWith('users/');
