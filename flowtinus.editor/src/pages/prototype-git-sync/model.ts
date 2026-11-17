import YAML from 'yaml';

export const WS = 'acme';

export type Tree = Record<string, string>;
export type Overlay = Record<string, string | null>;

export type CommitKind = 'initial' | 'commit' | 'merge' | 'promotion' | 'backport' | 'hotfix' | 'repair' | 'update' | 'outside' | 'config';
export type Commit = { sha: string; parents: string[]; message: string; author: string; at: number; tree: Tree; kind: CommitKind };

export type PrKind = 'change' | 'promotion' | 'backport' | 'hotfix';
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
    promotedSha?: string;
    method?: 'merge' | 'ff' | 'squash';
};

export type Mode = 'direct' | 'pull-request' | 'protected';
export type EnvDecl = { env: string; label: string; branch: string; promotesTo: string[]; mode: Mode };

/** a server's own configuration: the rest (its branch, mode, where it promotes) is the topology in the repo */
export type GitSettings = { repo: string; credential: string; env: string };

export type Version = { n: number; sha: string | null; message: string; hash: string; deployedField: boolean; at: number };
export type FlowRow = { id: string; name: string; versions: Version[]; current: number | null };
export type ScheduleDefaults = { cron: string; timezone: string; parameters: string; input: string };
export type ScheduleRow = { id: string; flowId: string; enabled: boolean; override: Partial<ScheduleDefaults> };
export type ConnectionRow = { id: string; name: string; type: string; configured: boolean };
export type FileMeta = { base: string | null; editor: string; conflict?: boolean; theirs?: string | null };

export type Server = {
    env: string;
    gitOn: boolean;
    settings: GitSettings;
    reconciledSha: string | null;
    refused: { sha: string; errors: string[] } | null;
    flows: Record<string, FlowRow>;
    pins: Record<string, number>;
    schedules: Record<string, ScheduleRow>;
    connections: Record<string, ConnectionRow>;
    scripts: Record<string, string>;
    working: Record<string, Overlay>;
    workingMeta: Record<string, Record<string, FileMeta>>;
    history: string[];
};

export type User = { slug: string; name: string };
export type Event = { id: number; at: number; text: string; tone: 'ok' | 'warn' | 'error' | 'info' };

export type PendingMerge = {
    env: string;
    branch: string;
    theirs: string;
    kind: CommitKind;
    message: string;
    pr?: { kind: PrKind; to: string; title: string };
};

export type State = {
    seq: number;
    clock: number;
    commits: Record<string, Commit>;
    branches: Record<string, string>;
    prs: Pr[];
    servers: Record<string, Server>;
    envOrder: string[];
    providerProtected: string[];
    users: User[];
    secrets: string[];
    session: {
        env: string;
        user: string;
        branchByEnvUser: Record<string, string>;
        variant: string;
        showMerged: boolean;
        pendingMerge: PendingMerge | null;
    };
    events: Event[];
};

export const POSTGRES = '__postgres__';
export const CONFIG_BRANCH = 'flowtinus/config';
export const TOPOLOGY_FILE = 'topology.yaml';

export function shortHash(text: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x1234567;
    for (let i = 0; i < text.length; i++) {
        h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619);
        h2 = Math.imul(h2 ^ text.charCodeAt(i), 2246822519);
    }
    return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 7);
}

/** the content hash of a version: without `deployed`, over normalized line endings */
export const versionHash = (content: string) => shortHash(content.replace(/\r\n/g, '\n').replace(/^deployed: .*\n?/m, ''));

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

export const treeAt = (state: State, sha: string | null | undefined): Tree => (sha ? (state.commits[sha]?.tree ?? {}) : {});

// ---------- line merge (diff3) ----------

export type Segment = { kind: 'ok'; lines: string[] } | { kind: 'conflict'; base: string[]; mine: string[]; theirs: string[] };

const splitLines = (text: string) => (text === '' ? [] : text.split('\n'));
const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

function lcsTable(a: string[], b: string[]): number[][] {
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
        }
    }
    return lcs;
}

function matchLines(a: string[], b: string[]): number[] {
    const lcs = lcsTable(a, b);
    const match = new Array<number>(a.length).fill(-1);
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            match[i++] = j++;
        } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
            i++;
        } else {
            j++;
        }
    }
    return match;
}

export function merge3(base: string, mine: string, theirs: string): Segment[] {
    const O = splitLines(base);
    const A = splitLines(mine);
    const B = splitLines(theirs);
    const mA = matchLines(O, A);
    const mB = matchLines(O, B);
    const out: Segment[] = [];
    const ok = (lines: string[]) => {
        if (lines.length === 0) {
            return;
        }
        const last = out.at(-1);
        if (last?.kind === 'ok') {
            last.lines.push(...lines);
        } else {
            out.push({ kind: 'ok', lines: [...lines] });
        }
    };
    let i = 0;
    let a = 0;
    let b = 0;
    for (;;) {
        let k = 0;
        while (i + k < O.length && mA[i + k] === a + k && mB[i + k] === b + k) {
            k++;
        }
        ok(O.slice(i, i + k));
        i += k;
        a += k;
        b += k;
        if (i >= O.length && a >= A.length && b >= B.length) {
            break;
        }
        let j = i;
        while (j < O.length && !(mA[j]! >= a && mB[j]! >= b)) {
            j++;
        }
        const [i2, a2, b2] = j < O.length ? [j, mA[j]!, mB[j]!] : [O.length, A.length, B.length];
        const o = O.slice(i, i2);
        const x = A.slice(a, a2);
        const y = B.slice(b, b2);
        if (sameLines(x, o)) {
            ok(y);
        } else if (sameLines(y, o) || sameLines(x, y)) {
            ok(x);
        } else {
            out.push({ kind: 'conflict', base: o, mine: x, theirs: y });
        }
        i = i2;
        a = a2;
        b = b2;
    }
    return out;
}

export type HunkChoice = 'mine' | 'theirs' | 'both' | { text: string };

export function joinSegments(segments: Segment[], choices: HunkChoice[] = []): string {
    let n = 0;
    return segments
        .flatMap(segment => {
            if (segment.kind === 'ok') {
                return segment.lines;
            }
            const choice = choices[n++] ?? 'mine';
            if (typeof choice === 'object') {
                return splitLines(choice.text);
            }
            return choice === 'mine' ? segment.mine : choice === 'theirs' ? segment.theirs : [...segment.mine, ...segment.theirs];
        })
        .join('\n');
}

// ---------- tree merge, with flows matched by id ----------

export type TreeConflict =
    | { key: string; kind: 'content'; path: string; segments: Segment[] }
    | { key: string; kind: 'modify-delete'; path: string; deleted: 'mine' | 'theirs'; content: string }
    | { key: string; kind: 'add-add'; path: string; mine: string; theirs: string }
    | { key: string; kind: 'rename-rename'; base: string; mine: string; theirs: string; content: string };

export const FLOW_EXT = '.flow.yaml';
const flowId = (content: string | undefined) => (content ? (/^id: (.+)$/m.exec(content)?.[1] ?? null) : null);
const dirOf = (path: string) => path.split('/').slice(0, -1).join('/');

function flowIds(tree: Tree): Map<string, string> {
    const ids = new Map<string, string>();
    for (const [path, content] of Object.entries(tree)) {
        const id = path.endsWith(FLOW_EXT) ? flowId(content) : null;
        if (id && !ids.has(id)) {
            ids.set(id, path);
        }
    }
    return ids;
}

function move(tree: Tree, from: string, to: string) {
    if (from === to || tree[from] === undefined) {
        return;
    }
    tree[to] = tree[from]!;
    delete tree[from];
}

/** git's merge.directoryRenames=true: a flow the other side added in a folder this side renamed follows the folder */
function followDirectoryRenames(base: Tree, renamer: Tree, adder: Tree) {
    const baseIds = flowIds(base);
    const renamerIds = flowIds(renamer);
    for (const path of Object.keys(adder)) {
        if (base[path] !== undefined || renamer[path] !== undefined || !path.endsWith(FLOW_EXT)) {
            continue;
        }
        const dir = dirOf(path);
        if (Object.keys(renamer).some(p => p.startsWith(`${dir}/`))) {
            continue;
        }
        const moved = new Set<string>();
        for (const [id, basePath] of baseIds) {
            if (dirOf(basePath) === dir) {
                const now = renamerIds.get(id);
                moved.add(now ? dirOf(now) : '');
            }
        }
        const target = moved.size === 1 ? [...moved][0]! : '';
        if (target && target !== dir) {
            move(adder, path, `${target}${path.slice(dir.length)}`);
        }
    }
}

export function mergeTrees(base: Tree, ours: Tree, theirs: Tree): { tree: Tree; conflicts: TreeConflict[] } {
    const O = { ...base };
    const A = { ...ours };
    const B = { ...theirs };
    const conflicts: TreeConflict[] = [];
    const held: Tree = {};
    const idsA = flowIds(A);
    const idsB = flowIds(B);
    for (const [id, p0] of flowIds(O)) {
        const pA = idsA.get(id);
        const pB = idsB.get(id);
        if (pA && pB && pA !== p0 && pB !== p0 && pA !== pB) {
            const segments = merge3(O[p0]!, A[pA]!, B[pB]!);
            const content = joinSegments(segments);
            conflicts.push({ key: `rename:${id}`, kind: 'rename-rename', base: p0, mine: pA, theirs: pB, content });
            held[pA] = content;
            delete O[p0];
            delete A[pA];
            delete B[pB];
        } else if (pA && pA !== p0 && (pB === p0 || pB === pA)) {
            move(O, p0, pA);
            move(B, p0, pA);
        } else if (pB && pB !== p0 && pA === p0) {
            move(O, p0, pB);
            move(A, p0, pB);
        }
    }
    followDirectoryRenames(O, A, B);
    followDirectoryRenames(O, B, A);

    const tree: Tree = { ...held };
    for (const path of new Set([...Object.keys(O), ...Object.keys(A), ...Object.keys(B)])) {
        const o = O[path];
        const a = A[path];
        const b = B[path];
        let result: string | undefined;
        if (a === b) {
            result = a;
        } else if (a === o) {
            result = b;
        } else if (b === o) {
            result = a;
        } else if (a === undefined) {
            conflicts.push({ key: path, kind: 'modify-delete', path, deleted: 'mine', content: b! });
            result = b;
        } else if (b === undefined) {
            conflicts.push({ key: path, kind: 'modify-delete', path, deleted: 'theirs', content: a });
            result = a;
        } else if (o === undefined && path.endsWith(FLOW_EXT) && flowId(a) !== flowId(b)) {
            conflicts.push({ key: path, kind: 'add-add', path, mine: a, theirs: b });
            result = a;
        } else {
            const segments = merge3(o ?? '', a, b);
            if (segments.some(s => s.kind === 'conflict')) {
                conflicts.push({ key: path, kind: 'content', path, segments });
                result = a;
            } else {
                result = joinSegments(segments);
            }
        }
        if (result !== undefined) {
            tree[path] = result;
        }
    }
    return { tree, conflicts: conflicts.sort((x, y) => x.key.localeCompare(y.key)) };
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
    const a = splitLines(before);
    const b = splitLines(after);
    const lcs = lcsTable(a, b);
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

// ---------- names ----------

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
    for (const segment of path.split('/')) {
        const problem = nameProblem(segment, 'script path segment');
        if (problem) {
            return problem;
        }
    }
    return null;
}

// ---------- the repo format ----------

export type Node = { id: string; type: string; label?: string; position: { x: number; y: number }; config?: Record<string, unknown> };
export type ScheduleDoc = { id: string; name: string } & ScheduleDefaults;
export type FlowDoc = { id: string; deployed?: boolean; workerTag: string; nodes: Node[]; edges: string[]; schedules?: ScheduleDoc[] };

export const isDeployed = (doc: FlowDoc) => doc.deployed !== false;

const sortKeys = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

/** what the app writes: `deployed` only when false, nodes by id, edges sorted, config keys a to z */
export function flowYaml(doc: FlowDoc): string {
    const out: Record<string, unknown> = { id: doc.id };
    if (doc.deployed === false) {
        out.deployed = false;
    }
    out.workerTag = doc.workerTag;
    out.nodes = [...doc.nodes]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(n => ({ ...n, ...(n.config ? { config: sortKeys(n.config) } : {}) }));
    out.edges = [...doc.edges].sort();
    if (doc.schedules?.length) {
        out.schedules = doc.schedules;
    }
    return YAML.stringify(out, { lineWidth: 0 });
}

export const parseFlow = (content: string) => YAML.parse(content) as FlowDoc;

function tryParse<T>(content: string): T | null {
    try {
        return (YAML.parse(content) as T) ?? null;
    } catch {
        return null;
    }
}

export type FlowItem = { id: string; name: string; project: string; folder: string; path: string; doc: FlowDoc };
export type ScriptItem = { project: string; rel: string; path: string; content: string };
export type ProjectItem = { name: string; path: string; meta: { id: string; description: string; color: string }; folders: string[] };
export type ConnectionDecl = { id: string; name: string; type: string; path: string };
export type WorkspaceView = { connections: ConnectionDecl[]; projects: ProjectItem[]; flows: FlowItem[]; scripts: ScriptItem[] };

export const workspaceFile = `${WS}/workspace.yaml`;
export const connectionFile = (name: string) => `${WS}/connections/${name}.yaml`;
export const projectDir = (project: string) => `${WS}/projects/${project}`;
export const flowFile = (project: string, folder: string, name: string) =>
    `${projectDir(project)}/flows/${folder ? `${folder}/` : ''}${name}${FLOW_EXT}`;
export const scriptFile = (project: string, rel: string) => `${projectDir(project)}/scripts/${rel}`;
export const connectionYaml = (id: string, type: string) => YAML.stringify({ id, type });

export function parseWorkspace(tree: Tree): WorkspaceView {
    const view: WorkspaceView = { connections: [], projects: [], flows: [], scripts: [] };
    const folders = new Map<string, Set<string>>();
    for (const [path, content] of Object.entries(tree)) {
        const parts = path.split('/');
        if (parts[0] !== WS) {
            continue;
        }
        if (parts[1] === 'connections' && parts.length === 3 && parts[2]!.endsWith('.yaml')) {
            const doc = tryParse<{ id?: string; type?: string }>(content);
            view.connections.push({ id: doc?.id ?? '', name: parts[2]!.slice(0, -5), type: doc?.type ?? '?', path });
            continue;
        }
        if (parts[1] !== 'projects' || parts.length < 4) {
            continue;
        }
        const project = parts[2]!;
        if (!folders.has(project)) {
            folders.set(project, new Set());
        }
        if (parts.length === 4 && parts[3] === 'project.yaml') {
            view.projects.push({
                name: project,
                path: projectDir(project),
                meta: tryParse<ProjectItem['meta']>(content) ?? { id: '', description: '', color: 'gray' },
                folders: [],
            });
        } else if (parts[3] === 'flows') {
            const rest = parts.slice(4);
            const file = rest.pop()!;
            for (let i = 1; i <= rest.length; i++) {
                folders.get(project)!.add(rest.slice(0, i).join('/'));
            }
            const doc = file.endsWith(FLOW_EXT) ? tryParse<FlowDoc>(content) : null;
            if (doc && typeof doc === 'object' && Array.isArray(doc.nodes)) {
                view.flows.push({ id: doc.id, name: file.slice(0, -FLOW_EXT.length), project, folder: rest.join('/'), path, doc });
            }
        } else if (parts[3] === 'scripts') {
            view.scripts.push({ project, rel: parts.slice(4).join('/'), path, content });
        }
    }
    for (const project of view.projects) {
        project.folders = [...(folders.get(project.name) ?? [])].sort();
    }
    view.projects.sort((a, b) => a.name.localeCompare(b.name));
    view.flows.sort((a, b) => a.path.localeCompare(b.path));
    view.scripts.sort((a, b) => a.path.localeCompare(b.path));
    view.connections.sort((a, b) => a.name.localeCompare(b.name));
    return view;
}

/** the core's whole-tree validation: an error refuses a commit, a pre-flight and a reconcile */
export function validateTree(tree: Tree): string[] {
    const errors: string[] = [];
    const rel = (path: string) => path.slice(WS.length + 1);
    const flowIdsSeen = new Map<string, string>();
    const connectionIds = new Map<string, string>();
    for (const [path, content] of Object.entries(tree)) {
        if (!path.startsWith(`${WS}/`)) {
            continue;
        }
        if (path.endsWith(FLOW_EXT) || path.endsWith('/project.yaml') || path.startsWith(`${WS}/connections/`)) {
            const doc = tryParse<{ id?: string }>(content);
            if (!doc || typeof doc !== 'object') {
                errors.push(`${rel(path)}: not valid YAML.`);
                continue;
            }
            if (!doc.id) {
                errors.push(`${rel(path)}: no id.`);
                continue;
            }
            const seen = path.endsWith(FLOW_EXT) ? flowIdsSeen : path.startsWith(`${WS}/connections/`) ? connectionIds : null;
            if (seen?.has(doc.id)) {
                errors.push(`${rel(path)}: id ${doc.id} is also in ${rel(seen.get(doc.id)!)}.`);
            }
            seen?.set(doc.id, path);
        }
    }
    const view = parseWorkspace(tree);
    for (const flow of view.flows) {
        const nodes = new Set(flow.doc.nodes.map(n => n.id));
        for (const edge of flow.doc.edges ?? []) {
            const [from, to] = edge.split('->').map(x => x.trim());
            if (!nodes.has(from!) || !nodes.has(to!)) {
                errors.push(`${flow.name}: the edge "${edge}" points to a node that does not exist.`);
            }
        }
        for (const node of flow.doc.nodes) {
            const script = node.config?.script;
            if (typeof script === 'string' && !view.scripts.some(s => s.project === flow.project && s.rel === script)) {
                errors.push(`${flow.name}: ${node.label ?? node.id} calls the script ${script}, which does not exist.`);
            }
            const connection = node.config?.connection;
            if (typeof connection === 'string' && !connectionIds.has(connection)) {
                errors.push(`${flow.name}: ${node.label ?? node.id} uses the connection ${connection}, which is not declared.`);
            }
        }
    }
    return errors;
}

export const sameName = (a: string, b: string) => a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();

// ---------- topology (topology.yaml on flowtinus/config) ----------

export const topologyYaml = (environments: EnvDecl[]) => YAML.stringify({ environments }, { lineWidth: 0 });

export function topology(state: State): EnvDecl[] {
    const text = treeAt(state, state.branches[CONFIG_BRANCH])[TOPOLOGY_FILE];
    return text ? ((tryParse<{ environments?: EnvDecl[] }>(text)?.environments ?? []) as EnvDecl[]) : [];
}

export const envDecl = (state: State, env: string) => topology(state).find(e => e.env === env);
export const branchOf = (state: State, env: string) => envDecl(state, env)?.branch ?? env.toLowerCase();
export const modeOf = (state: State, env: string): Mode => envDecl(state, env)?.mode ?? 'direct';
export const labelOf = (state: State, env: string) => envDecl(state, env)?.label ?? env;
export const envOfBranch = (state: State, branch: string) => topology(state).find(e => e.branch === branch)?.env ?? null;
export const sourceOf = (state: State, env: string) => topology(state).find(e => e.promotesTo.includes(env))?.env ?? null;

/** backport/<env branch>-<sha> goes into the source of that environment */
export function backportTarget(state: State, branch: string): string | null {
    const from = envOfBranch(state, branch.replace(/^backport\//, '').replace(/-[^-]+$/, ''));
    return from ? sourceOf(state, from) : null;
}

export function rootOf(state: State, env: string): string {
    const seen = new Set([env]);
    let current = env;
    for (let source = sourceOf(state, current); source && !seen.has(source); source = sourceOf(state, current)) {
        seen.add(source);
        current = source;
    }
    return current;
}

export function topologyProblems(environments: EnvDecl[]): string[] {
    const problems: string[] = [];
    const names = new Set(environments.map(e => e.env));
    for (const env of environments) {
        const sources = environments.filter(other => other.promotesTo.includes(env.env));
        if (sources.length > 1) {
            problems.push(`${env.env} has two sources (${sources.map(s => s.env).join(', ')}): the topology is a tree.`);
        }
        for (const target of env.promotesTo) {
            if (!names.has(target)) {
                problems.push(`${env.env} promotes to ${target}, which is not an environment.`);
            }
            if (target === env.env) {
                problems.push(`${env.env} promotes to itself.`);
            }
        }
        if (environments.filter(other => other.branch === env.branch).length > 1) {
            problems.push(`The branch ${env.branch} belongs to two environments.`);
        }
    }
    return [...new Set(problems)];
}

// ---------- ahead, lineage ----------

/** files that merging the environment into its source would change there: not a count of commits */
export function aheadFiles(state: State, env: string): string[] {
    const source = sourceOf(state, env);
    if (!source) {
        return [];
    }
    const tip = state.branches[branchOf(state, env)];
    const sourceTip = state.branches[branchOf(state, source)];
    if (!tip || !sourceTip || isAncestor(state, tip, sourceTip)) {
        return [];
    }
    const base = mergeBase(state, tip, sourceTip);
    const merged = mergeTrees(treeAt(state, base), treeAt(state, sourceTip), treeAt(state, tip));
    return [
        ...new Set([
            ...changesBetween(treeAt(state, sourceTip), merged.tree).map(c => c.path),
            ...merged.conflicts.map(c => ('path' in c ? c.path : c.base)),
        ]),
    ];
}

/** the last promotion merged into the environment must be an ancestor of its branch: a squash breaks that */
export function brokenLineage(state: State, env: string): Pr | null {
    const branch = branchOf(state, env);
    const tip = state.branches[branch];
    const last = state.prs
        .filter(p => p.kind === 'promotion' && p.state === 'merged' && p.to === branch && p.promotedSha)
        .sort((a, b) => b.number - a.number)[0];
    return last && tip && !isAncestor(state, last.promotedSha!, tip) ? last : null;
}

// ---------- branches ----------

export type BranchKind = 'environment' | 'config' | 'promotion' | 'backport' | 'hotfix' | 'user' | 'shared';

export function branchKind(state: State, branch: string): BranchKind {
    if (branch === CONFIG_BRANCH) {
        return 'config';
    }
    if (envOfBranch(state, branch)) {
        return 'environment';
    }
    if (branch.startsWith('promote/')) {
        return 'promotion';
    }
    if (branch.startsWith('backport/')) {
        return 'backport';
    }
    if (branch.startsWith('hotfix/')) {
        return 'hotfix';
    }
    return branch.startsWith('users/') ? 'user' : 'shared';
}

export const ownerOf = (branch: string) => (branch.startsWith('users/') ? (branch.split('/')[1] ?? null) : null);
export const isWorkBranch = (state: State, branch: string) => ['user', 'shared', 'hotfix', 'backport'].includes(branchKind(state, branch));
